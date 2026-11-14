/**
 * Folders inside folders, the quiet shelf and the suggested layout, end to end against a demo hub in headless
 * Chromium (docs/organize.md):
 * - quiet servers sit on a shelf at the end of the rail, and a click lays them out;
 * - the Organize view suggests a layout from Discord's folders, shared words and your two accounts, as a tree;
 * - Apply makes an account folder each, with the folders inside, and the rail opens them one level deep;
 * - a quiet server inside a folder goes on that folder's shelf; Undo puts every folder back;
 * - the phone's Spaces list shows a folder inside a folder as a row that opens it.
 *
 *   DITHER_DEMO_SCENARIO=servers bun packages/hub/src/main.ts --demo --data /tmp/x --port 8547 --web packages/web/dist
 *   bun scripts/verify-folders.ts http://127.0.0.1:8547 [/tmp/shots]
 * The hub must be a fresh demo hub with its own data dir and the servers scenario: this rearranges its folders.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8547';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
const b0 = await bootstrap();
if (!b0.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
if (!b0.spaces.some((s: any) => s.name === 'Lakeside Chess Club')) throw new Error('start the demo hub with DITHER_DEMO_SCENARIO=servers');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const center = (sel: string) =>
  p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function click(sel: string) {
  const r = await center(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
/** The rail button of the folder with this name (its tooltip title is not an attribute: find it by the folder's id). */
const folderSel = async (name: string) => {
  const f = (await bootstrap()).folders.find((x: any) => x.name === name);
  return f ? `.rail [data-dnd-key="folder:${f.id}"] > .rail-btn` : null;
};
const away = () => p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 600 });

try {
  await p.size(1280, 1000);
  // The demo files a few servers; start from none, as someone new would.
  await fetch(`${hub}/api/folders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [] }) });
  await p.goto(`${hub}/#/`);
  await p.until(`document.querySelectorAll('.rail-scroll .rail-item[data-dnd-key^="space:"]').length > 20`, 20000);
  await Bun.sleep(800);

  // The quiet shelf at the end of the rail.
  const shelf = await p.eval<string | null>(`document.querySelector('.rail-scroll > .rail-shelf .rail-shelf-n')?.textContent ?? null`);
  check(shelf && Number(shelf) >= 8, 'quiet servers sit on a shelf at the end of the rail', shelf);
  const quietShown = () => p.eval<number>(`document.querySelectorAll('.rail-scroll .rail-item.quiet').length`);
  check((await quietShown()) === 0, 'closed, it shows none of them');
  if (shots) {
    await p.eval(`document.querySelector('.rail-scroll').scrollTop = 1e6`);
    await p.shot(`${shots}/1-rail-shelf-closed.png`);
  }
  await click('.rail-scroll > .rail-shelf .rail-btn');
  await Bun.sleep(300);
  check((await quietShown()) === Number(shelf), 'a click lays them out, dimmed', await quietShown());
  if (shots) {
    await p.eval(`document.querySelector('.rail-scroll').scrollTop = 1e6`);
    await p.shot(`${shots}/2-rail-shelf-open.png`);
  }
  await click('.rail-scroll > .rail-shelf .rail-btn');

  // The suggested layout in the Organize view.
  await click('.rail-sort .rail-btn');
  await p.until(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].some((e) => e.textContent.includes('Organize Servers'))`, 5000);
  check(await p.eval<boolean>(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].some((e) => e.textContent.includes('Quiet Servers on a Shelf'))`), 'the order menu can turn the shelf off');
  await p.eval(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].find((e) => e.textContent.includes('Organize Servers')).click()`);
  await p.until(`!!document.querySelector('.org-plan')`, 5000);
  const plan = await p.eval<any>(`(() => ({
    personas: document.querySelector('.org-plan-persona')?.textContent ?? null,
    accounts: [...document.querySelectorAll('.org-plan-acc')].map((e) => e.firstChild ? e.textContent : ''),
    steps: [...document.querySelectorAll('.org-plan-row:not(.org-plan-persona) .org-plan-name')].map((e) => e.textContent),
    apply: document.querySelector('.org-plan-foot .btn')?.textContent,
  }))()`);
  check(/zyansheep/.test(plan.personas) && /zyn\.alt/.test(plan.personas), 'it offers one folder per account', plan.personas);
  check(['Coding', 'Creators', 'Lakeside', 'Ashford', 'Westbrook'].every((n) => plan.steps.some((s: string) => s.startsWith(n))), 'from Discord’s folders and shared words', plan.steps);
  if (shots) await p.shot(`${shots}/3-suggested-layout.png`);

  // Untick one step, then apply.
  await p.eval(`[...document.querySelectorAll('.org-plan-row')].find((r) => r.querySelector('.org-plan-name')?.textContent.startsWith('Tuesday'))?.querySelector('input')?.click()`);
  await Bun.sleep(100);
  await click('.org-plan-foot .btn.primary');
  await p.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Layout applied'))`, 5000);
  await Bun.sleep(800);
  check((await bootstrap()).folders.length > 5, 'Apply made the folders');
  // Undo puts every folder back; then take it again for the rest.
  await click('.toast .toast-action');
  await Bun.sleep(800);
  check((await bootstrap()).folders.length === 0, 'Undo puts every folder back', (await bootstrap()).folders.length);
  await p.until(`!!document.querySelector('.org-plan-foot .btn.primary')`, 3000);
  // What was unticked stays unticked.
  await click('.org-plan-foot .btn.primary');
  await Bun.sleep(800);
  const b1 = await bootstrap();
  const byName = (n: string) => b1.folders.find((f: any) => f.name === n);
  const main = byName('zyansheep');
  const alt = byName('zyn.alt');
  const inner = (f: any) => f?.items.filter((i: any) => i.kind === 'folder').map((i: any) => b1.folders.find((x: any) => x.id === i.id)?.name);
  check(main && alt, 'each account got a folder', b1.folders.map((f: any) => f.name));
  check(['Coding', 'Creators', 'Westbrook'].every((n) => inner(main)?.includes(n)), 'its folders are inside it', inner(main));
  check(['Lakeside', 'Ashford'].every((n) => inner(alt)?.includes(n)) && !inner(alt)?.some((n: string) => n?.startsWith('Tuesday')), 'the unticked folder was not made', inner(alt));
  check(byName('Ashford')?.items.some((i: any) => b1.spaces.find((s: any) => s.id === i.id)?.name === 'Mossy Board Games'), 'the board games came along with Discord’s Ashford folder');
  const top = await p.eval<string[]>(`[...document.querySelectorAll('.rail-scroll > .rail-folder > .rail-item, .rail-scroll > .rail-item')].map((e) => e.dataset.dndKey).filter(Boolean)`);
  check(!top.includes(`folder:${byName('Lakeside')?.id}`), 'a folder inside a folder is not at the top of the rail');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.until(`!document.querySelector('.org-plan')`, 3000).catch(() => p.eval(`document.querySelector('.modal-close, [aria-label="Close"]')?.click()`));
  await away();
  if (shots) {
    await p.eval(`document.querySelector('.rail-scroll').scrollTop = 0`);
    await p.shot(`${shots}/4-rail-after-closed.png`);
  }

  // Open the alt account's folder, then Lakeside inside it; and the main one's Westbrook, whose servers went quiet.
  const opened = (sel: string) => p.until(sel, 4000).then(() => true, () => false);
  await click((await folderSel('zyn.alt'))!);
  check(await opened(`!!document.querySelector('.rail-folder.open .rail-folder.inner')`), 'an open account folder shows its folders inside it');
  await click((await folderSel('Lakeside'))!);
  check(await opened(`!!document.querySelector('.rail-folder.open .rail-folder.inner.open .rail-item[data-dnd-key^="space:"]')`), 'and a folder inside it opens in place');
  await click((await folderSel('zyansheep'))!);
  await opened(`document.querySelectorAll('.rail-scroll > .rail-folder.open').length === 2`);
  await click((await folderSel('Westbrook'))!);
  await opened(`[...document.querySelectorAll('.rail-folder.inner.open')].some((x) => x.querySelector('.rail-shelf'))`);
  const wbShelf = await p.eval<string | null>(`(() => { const f = [...document.querySelectorAll('.rail-folder.inner.open')].find((x) => x.querySelector('.rail-shelf')); return f?.querySelector('.rail-shelf-n')?.textContent ?? null; })()`);
  check(wbShelf === '4', 'a folder of quiet servers keeps them on its own shelf', wbShelf);
  await away();
  if (shots) {
    await p.eval(`document.querySelector('.rail-scroll').scrollTop = 0`);
    await p.shot(`${shots}/5-rail-nested-open.png`);
    await p.eval(`(() => { const e = [...document.querySelectorAll('.rail-folder.inner.open')].find((x) => x.querySelector('.rail-shelf')); e?.scrollIntoView({ block: 'center' }); })()`);
    await p.shot(`${shots}/6-rail-westbrook-shelf.png`);
  }

  // The phone: a folder inside a folder is a row that opens it.
  await p.size(390, 800, true);
  await p.goto(`${hub}/#/f/${alt.id}`);
  await Bun.sleep(1200);
  const rows = await p.eval<string[]>(`[...document.querySelectorAll('.sidebar .row-title')].map((e) => e.textContent)`);
  check(rows.includes('Lakeside') && rows.includes('Ashford'), 'on a phone, the account folder lists its folders', rows.slice(0, 8));
  if (shots) await p.shot(`${shots}/7-phone-account-folder.png`);
  await p.goto(`${hub}/#/f/${byName("Lakeside").id}`);
  await Bun.sleep(800);
  check(await p.eval<boolean>(`[...document.querySelectorAll('.sidebar .side-sub .link-btn')].some((e) => e.textContent === 'zyn.alt')`), 'and a folder inside one says where it is');
  if (shots) await p.shot(`${shots}/8-phone-inner-folder.png`);

  // Undo puts it all back.
  await p.size(1280, 1000);
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.rail .rail-btn')`, 15000);
  await click('.rail-sort .rail-btn');
  await p.until(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].some((e) => e.textContent.includes('Organize Servers'))`, 5000);
  await p.eval(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].find((e) => e.textContent.includes('Organize Servers')).click()`);
  await p.until(`!!document.querySelector('.org-list')`, 5000);
  const near = await p.eval<number>(`document.querySelectorAll('.org-near .chip-btn').length`);
  check(near > 0, 'loose servers show their nearest folders beside them', near);
  if (shots) {
    await p.eval(`document.querySelector('.org-near')?.scrollIntoView({ block: 'center' })`);
    await p.shot(`${shots}/9-organize-near.png`);
  }
} catch (e) {
  console.log('FAIL', (e as Error).message);
  failures++;
} finally {
  if (p.errors.length) console.log('page errors:', p.errors.slice(0, 5));
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
