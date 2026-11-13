/**
 * Reply marks (docs/inbox.md, "Marks"), end to end in headless Chromium against a demo hub, as gestures on inbox rows
 * (ui/ReplyMark.tsx):
 *
 * - Computer: hovering a row's ↩ makes it a button with ✕ that says "No reply needed"; a click takes the ↩ off at once
 *   without opening the chat, the hub's fold agrees a few seconds later, and the toast's Undo brings it back. A row
 *   with no ↩ shows a faint one while hovered ("Reply needed"); a click holds the row (the hub says
 *   `replyMark: 'needs'`), and the ↩ it now shows, clicked, lets go. The button is reached with Tab. Neither the row's
 *   menu nor a message's has the marks any more.
 * - Phone: swiping a row with ↩ left shows "No reply needed" under it and marks it; a row without, "Reply needed". A
 *   short slow swipe does nothing, nor does a vertical one. With a page peeking at the edge, a left swipe on a row is
 *   the row's, and one from the peeking card still brings the page back.
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
const key = async (k: string, code = k, vk = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const at = async (sel: string, pick = 'el => true'): Promise<[number, number]> => {
  const r = await p.eval<[number, number] | null>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const items = () => p.eval<string[]>(`[...document.querySelectorAll('.cm .cm-item, .cm-sheet .sheet-action')].map((e) => e.textContent.trim())`);
const noMarks = (menu: string[]) => !menu.some((l) => l.startsWith('No reply needed') || l.startsWith('Reply needed'));
const owedRow = (k: string) => p.eval<boolean>(`!!document.querySelector('[data-row="${k}"] .row-owed')`);
const wrap = (k: string) => `[data-row-key="${k}"]`;
const mark = (k: string) => `${wrap(k)} > .row-mark`;
const markState = (k: string) =>
  p.eval<{ label: string; title: string; opacity: number; x: boolean; owedHidden: boolean } | null>(`(() => {
    const b = document.querySelector(${JSON.stringify(mark(k))});
    if (!b) return null;
    const o = document.querySelector('[data-row="${k}"] .row-owed');
    return { label: b.getAttribute('aria-label'), title: b.title, opacity: Number(getComputedStyle(b).opacity), x: getComputedStyle(b, '::before').display !== 'none', owedHidden: !!o && getComputedStyle(o).visibility === 'hidden' };
  })()`);
const toastNow = (title: string) => p.eval<boolean>(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(${JSON.stringify(title)}) && t.textContent.includes('Undo'))`);
/** The toast comes once the hub has answered. */
const hasToast = (title: string) => until(() => toastNow(title), 5000);
const clearToasts = () => p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
/** A row with ↩, or a row that can be held (no ↩), that is one conversation (a chat of several is keyed by its person). */
const findRow = (kind: 'owes' | 'can-need', not: string[] = []) =>
  p.eval<string | null>(`[...document.querySelectorAll('.sidebar .inbox-row.${kind}')].map((el) => el.dataset.rowKey).find((k) => k.startsWith('cnv_') && !${JSON.stringify(not)}.includes(k)) ?? null`);

// ------------------------------------------------------------------ computer
await p.size(1280, 800);
await p.goto(`${hub}/#/inbox`);
await p.until(`document.querySelectorAll('.sidebar [data-row]').length > 3`, 15000);
await p.until(`[...document.querySelectorAll('.sidebar .inbox-row.owes')].some((el) => el.dataset.rowKey.startsWith('cnv_'))`, 15000);
const owes = (await findRow('owes'))!;
const before = await view(owes);
check(before?.owedSince != null, 'a row owes a reply, with ↩', { owedSince: before?.owedSince != null });

// The row's menu: "Why it's here" and Mark As Read, no marks.
await click(...(await at(`[data-row="${owes}"]`)), 'right');
let menu = await items();
check(menu.length > 0 && noMarks(menu), 'its menu has no reply marks any more', menu.slice(0, 4));
await key('Escape', 'Escape', 27);

// Hover the row, then its ↩.
const [rx, ry] = await at(`[data-row="${owes}"]`);
await mouse('mouseMoved', rx, ry);
await Bun.sleep(150);
let st = await markState(owes);
check(st && st.opacity === 0 && !st.x, 'hovering the row: the ↩ looks as before', st);
const [mx, my] = await at(mark(owes));
const owedBox = await p.eval<number[]>(`(() => { const b = document.querySelector('[data-row="${owes}"] .row-owed').getBoundingClientRect(); return [b.right, b.top + b.height / 2]; })()`);
const markBox = await p.eval<number[]>(`(() => { const b = document.querySelector(${JSON.stringify(mark(owes))}).getBoundingClientRect(); return [b.right, b.top + b.height / 2]; })()`);
check(Math.abs(owedBox[0] - markBox[0]) <= 5 && Math.abs(owedBox[1] - markBox[1]) <= 4, 'its button sits on the ↩', { owed: owedBox, button: markBox });
await mouse('mouseMoved', mx, my);
await Bun.sleep(200);
st = await markState(owes);
check(st && st.opacity === 1 && st.x && st.owedHidden && st.label === 'No reply needed' && st.title === 'No reply needed', 'hovering the ↩: it shows ✕, "No reply needed"', st);
if (shots) await p.shot(`${shots}/hover-owed.png`);
const hash0 = await p.eval<string>('location.hash');
await click(mx, my);
check(!(await owedRow(owes)), 'a click: the ↩ goes at once');
check((await p.eval<string>('location.hash')) === hash0, '…without opening the chat', await p.eval<string>('location.hash'));
check(await hasToast('No reply needed'), '…with a toast that offers Undo');
check(await until(async () => (await view(owes))?.owedSince === null, 20000), '…and the hub folds it: nothing owed');
await click(...(await at('.toast', `el => el.textContent.includes('Undo')`)));
check(await until(async () => (await view(owes))?.owedSince === before.owedSince, 20000), 'Undo on the toast: owed again, since the same message');
check(await until(() => owedRow(owes), 5000), '…with its ↩ back');
await clearToasts();

// A row with no ↩: a faint one while hovered, "Reply needed".
const free = await findRow('can-need');
check(!!free, 'a row with no ↩ that can be held', free);
if (free) {
  const [fx, fy] = await at(`[data-row="${free}"]`);
  await mouse('mouseMoved', fx, fy);
  await Bun.sleep(200);
  st = await markState(free);
  check(st && st.opacity > 0 && st.opacity < 1 && st.label === 'Reply needed', 'hovering a row without ↩: a faint ↩, "Reply needed"', st);
  if (shots) await p.shot(`${shots}/hover-free.png`);
  const [gx, gy] = await at(mark(free));
  await mouse('mouseMoved', gx, gy);
  await Bun.sleep(150);
  st = await markState(free);
  check(st?.opacity === 1, '…full on its own hover', st);
  await click(gx, gy);
  check(await until(() => owedRow(free), 3000), 'a click: the ↩ shows at once');
  check(await hasToast('Reply needed'), '…with a toast that offers Undo');
  check(await until(async () => (await view(free))?.replyMark === 'needs', 20000), '…and the hub holds the row', await view(free));
  await clearToasts();
  // Held: its ↩ takes the hold off.
  await p.until(`!!document.querySelector(${JSON.stringify(`${wrap(free)}.owes`)})`, 10000).catch(() => {});
  const [hx, hy] = await at(mark(free));
  await mouse('mouseMoved', hx, hy);
  await Bun.sleep(150);
  st = await markState(free);
  check(st?.label === 'No reply needed' && st.x, 'held: its ↩ says "No reply needed"', st);
  await click(hx, hy);
  check(await until(async () => (await view(free))?.replyMark === undefined && (await view(free))?.owedSince == null, 20000), '…and a click lets go', await view(free));
  await clearToasts();
}

// Keyboard: Tab from the row reaches its button, named; Enter marks.
await p.eval(`document.querySelector('[data-row="${owes}"]').focus()`);
await key('Tab', 'Tab', 9);
const focused = await p.eval<{ tag: string; label: string | null; cls: string }>(`({ tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label'), cls: document.activeElement.className })`);
check(focused.tag === 'BUTTON' && focused.cls.includes('row-mark') && focused.label === 'No reply needed', 'Tab from the row reaches its ↩ button, named', focused);
st = await markState(owes);
check(st?.opacity === 1 && st.x, '…which shows while focused', st);
await key('Enter', 'Enter', 13);
check(await until(async () => (await view(owes))?.owedSince === null, 20000), 'Enter on it marks "No reply needed"');
await click(...(await at('.toast', `el => el.textContent.includes('Undo')`)));
check(await until(async () => (await view(owes))?.owedSince === before.owedSince, 20000), '…and Undo brings it back');
await clearToasts();

// A message from someone else: no marks in its menu.
await click(...(await at(`[data-row="${owes}"]`)));
const lastFromThem = `.msg:not(.system):not(.pending) .msg-body`;
await p.until(`document.querySelectorAll(${JSON.stringify(lastFromThem)}).length > 0`, 15000);
await Bun.sleep(400);
await click(...(await at(lastFromThem, '(el, i, all) => i === all.length - 1')), 'right');
menu = await items();
check(menu.length > 0 && noMarks(menu), 'a message from someone else: no reply marks in its menu', menu.filter((l) => /reply/i.test(l)));
await key('Escape', 'Escape', 27);

// ------------------------------------------------------------------ phone
const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function swipe(a: [number, number], b: [number, number], opts: { steps?: number; ms?: number; mid?: () => Promise<void> } = {}) {
  const steps = opts.steps ?? 12;
  await touch('touchStart', [a]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]]);
    await Bun.sleep(opts.ms ?? 16);
    if (i === Math.ceil((steps * 3) / 4) && opts.mid) await opts.mid();
  }
  await touch('touchEnd', []);
  await Bun.sleep(450);
}
await p.size(390, 844, true);
await p.goto(`${hub}/#/inbox`);
await p.until(`!!document.querySelector('.app.phone')`, 15000);
await p.until(`[...document.querySelectorAll('.inbox-row.owes')].some((el) => el.dataset.rowKey.startsWith('cnv_'))`, 15000);
await Bun.sleep(500);
const phoneOwes = (await findRow('owes'))!;
check(await p.eval(`getComputedStyle(document.querySelector(${JSON.stringify(mark(phoneOwes))})).clipPath !== 'none'`), 'phone: the ↩ button is out of sight (the swipe does it)');

// A long-press sheet has no marks.
const [px, py] = await at(`[data-row="${phoneOwes}"]`);
await touch('touchStart', [[px, py]]);
await Bun.sleep(650);
await touch('touchEnd', []);
await Bun.sleep(400);
menu = await items();
check(menu.length > 0 && noMarks(menu), "phone: a row's long-press sheet has no marks", menu.slice(0, 4));
await p.eval('history.back()');
await Bun.sleep(400);

// A short slow swipe does nothing; a vertical one neither.
let [sx, sy] = await at(`[data-row="${phoneOwes}"]`);
await swipe([sx + 60, sy], [sx + 30, sy], { steps: 10, ms: 40 });
await Bun.sleep(800);
check((await owedRow(phoneOwes)) && !(await toastNow('No reply needed')), 'a short slow swipe settles back, unmarked');
[sx, sy] = await at(`[data-row="${phoneOwes}"]`);
await swipe([sx, sy], [sx - 4, sy - 160], { steps: 10 });
await Bun.sleep(800);
check((await owedRow(phoneOwes)) && !(await p.eval(`!!document.querySelector('.inbox-row.swiping')`)) && !(await toastNow('No reply needed')), 'a vertical drag is the list\'s, not the row\'s');

// Swipe left on a row with ↩: "No reply needed" under it, then marked.
[sx, sy] = await at(`[data-row="${phoneOwes}"]`);
type Under = { label: string; visible: boolean; moved: string };
let under = null as Under | null;
await swipe([sx + 100, sy], [sx - 60, sy], {
  mid: async () => {
    under = await p.eval<Under | null>(`(() => { const w = document.querySelector(${JSON.stringify(wrap(phoneOwes))}); const u = w?.querySelector('.row-swipe-under'); if (!u) return null; return { label: u.textContent.trim(), visible: getComputedStyle(u).visibility === 'visible', moved: w.querySelector(':scope > .row').style.transform }; })()`);
    if (shots) await p.shot(`${shots}/phone-swipe-owed.png`);
  },
});
check(under?.label === 'No reply needed' && under.visible && /translateX\(-/.test(under.moved), 'swiping a row with ↩: the row follows, "No reply needed" under it', under);
check(!(await owedRow(phoneOwes)), '…let go past the line: the ↩ goes', await view(phoneOwes));
check(!(await p.eval<boolean>(`location.hash.includes('/c/')`)), '…and the chat did not open');
check(await hasToast('No reply needed'), '…with Undo on the toast');
check(await until(async () => (await view(phoneOwes))?.owedSince === null, 20000), '…and the hub agrees');
await clearToasts();

// A row without ↩: "Reply needed".
const phoneFree = await findRow('can-need', free ? [free] : []);
check(!!phoneFree, 'phone: a row with no ↩ that can be held', phoneFree);
if (phoneFree) {
  [sx, sy] = await at(`[data-row="${phoneFree}"]`);
  await swipe([sx + 100, sy], [sx - 60, sy], {
    mid: async () => {
      under = await p.eval<Under | null>(`(() => { const w = document.querySelector(${JSON.stringify(wrap(phoneFree))}); const u = w?.querySelector('.row-swipe-under'); if (!u) return null; return { label: u.textContent.trim(), visible: getComputedStyle(u).visibility === 'visible', moved: '' }; })()`);
    },
  });
  check(under?.label === 'Reply needed' && under.visible, 'swiping a row without ↩: "Reply needed" under it', under);
  check(await until(async () => (await view(phoneFree))?.replyMark === 'needs', 20000), '…and the hub holds it', await view(phoneFree));
  await clearToasts();
}

// With a page peeking at the edge: a left swipe on a row is the row's; one from the card brings the page back.
await p.until(`[...document.querySelectorAll('.inbox-row.owes')].length > 0`, 10000);
const open = (await p.eval<string>(`[...document.querySelectorAll('.inbox-row')].map((el) => el.dataset.rowKey).find((k) => k.startsWith('cnv_'))`))!;
await touch('touchStart', [await at(`[data-row="${open}"]`)]);
await touch('touchEnd', []);
await p.until(`location.hash.includes('/c/')`, 5000);
await Bun.sleep(700);
const page = await p.eval<string>('location.hash');
await swipe([30, 420], [300, 430], { steps: 14 });
await p.until(`document.querySelector('.app').classList.contains('rest-peek')`, 3000).catch(() => {});
check(await p.eval(`document.querySelector('.app').classList.contains('rest-peek')`), 'swipe right from a chat: the inbox, with the chat peeking');
await clearToasts();
const peekRow = await p.eval<string | null>(
  `[...document.querySelectorAll('.inbox-row.markable')].map((el) => [el.dataset.rowKey, el.getBoundingClientRect()]).find(([k, b]) => b.top > 140 && b.bottom < 760)?.[0] ?? null`,
);
if (peekRow) {
  const wasOwed = await owedRow(peekRow);
  const b = await p.eval<number[]>(`(() => { const r = document.querySelector('[data-row="${peekRow}"]').getBoundingClientRect(); return [r.top + r.height / 2]; })()`);
  await swipe([300, b[0]], [60, b[0]]);
  check(await p.eval(`document.querySelector('.app').classList.contains('rest-peek')`), 'a left swipe on a row beside the peeking chat: the chat stays where it is');
  check(await hasToast(wasOwed ? 'No reply needed' : 'Reply needed'), '…and the row is marked', { wasOwed });
  await clearToasts();
}
await swipe([370, 500], [60, 500]);
check((await p.eval<string>('location.hash')) === page && (await p.eval(`document.querySelector('.app').classList.contains('rest-open')`)), 'a left swipe from the peeking card brings the chat back', await p.eval<string>('location.hash'));

check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
await close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
