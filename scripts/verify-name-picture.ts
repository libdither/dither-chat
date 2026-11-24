/**
 * Choosing a person's name and picture from their profile's hero (namechoices.ts, docs/profile.md "Which account
 * speaks for them"), end to end against a demo hub in headless Chromium: the button beside the name lists the main
 * account's name and each account's nickname, display name and handle; a pick names them, ticked when the menu opens
 * again, and the main account's puts it back. Their picture opens a menu of each account's picture, View Picture
 * first; a pick shows it, and View Picture opens that one. One account's names on a page of their own. The same on a
 * phone, as a sheet.
 *
 *   DITHER_DEMO_SCENARIO=multiaccount bun run hub -- --demo --data <tmp> --port <port>
 *   bun scripts/verify-name-picture.ts http://127.0.0.1:<port> [/tmp/shots]
 * The hub must be a fresh demo hub with the multiaccount scenario (Kit, seven accounts, each with a picture).
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const kit = boot.persons.find((p: any) => !p.isSelf && p.identityIds.length >= 5);
// Someone of one account whose display name and handle differ: two names to choose from.
const ids = new Map<string, any>(boot.identities.map((i: any) => [i.id, i]));
const solo = boot.persons.find((p: any) => {
  const i = p.identityIds.length === 1 && ids.get(p.identityIds[0]);
  return !p.isSelf && i && i.network === 'discord' && i.displayName && i.handle && i.displayName !== i.handle;
});
if (!kit || !solo) throw new Error('not the multiaccount scenario: no one with five accounts, or of one Discord account');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const at = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const click = async (sel: string) => {
  const r = await at(sel);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const tap = async (sel: string) => {
  const r = await at(sel);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
/** The open menu's items: text, second line, ticked. */
const items = () =>
  p.eval<{ label: string; detail: string; on: boolean }[]>(
    `[...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]')].map((b) => ({ label: (b.querySelector('.cm-two > .cm-text') ?? b.querySelector('.cm-text'))?.textContent.trim() ?? '', detail: b.querySelector('.cm-detail')?.textContent.trim() ?? '', on: b.getAttribute('aria-checked') === 'true' }))`,
  );
const pick = async (label: string, detail?: string) => {
  const sel = `[...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]')].find((b) => (b.querySelector('.cm-two > .cm-text') ?? b.querySelector('.cm-text'))?.textContent.trim() === ${JSON.stringify(label)}${detail ? ` && b.querySelector('.cm-detail')?.textContent.trim() === ${JSON.stringify(detail)}` : ''})`;
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = ${sel}; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no menu item ${label} ${detail ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const escape = () => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
const heroName = () => p.eval<string>(`document.querySelector('.pf-title h1')?.innerText.trim() ?? ''`);
const heroPic = () => p.eval<string>(`document.querySelector('.pf-avatar img')?.getAttribute('src') ?? ''`);
const menuOpen = () => p.until(`!!document.querySelector('[role="menuitemradio"], [role="menuitem"]')`, 3000);
const menuShut = () => p.until(`!document.querySelector('[role="menuitemradio"], [role="menuitem"]')`, 3000);

try {
  await p.size(1280, 860);
  await p.goto(`${hub}/#/p/${kit.id}`);
  await p.until(`!!document.querySelector('.profile-page .pf-name-swap')`, 15000);
  const first = await heroName();

  // The name.
  await click('.pf-name-swap');
  await menuOpen();
  let names = await items();
  check(names[0]?.label === first && names[0].on && names[0].detail.startsWith('Main account'), 'the main account’s name first, ticked', names[0]);
  check(names.some((n) => n.detail.startsWith('Display name')) && names.some((n) => n.detail.startsWith('Handle')), 'each account’s display names and handles', names.map((n) => `${n.label} — ${n.detail}`));
  check(!names.some((n) => /^\+?[\d\s]+$/.test(n.label)), 'no phone number among them');
  check(new Set(names.map((n) => n.label)).size === names.length, 'each name once');
  if (shots) await p.shot(`${shots}/name-menu.png`);
  const other = names.find((n) => n.detail.startsWith('Handle') && n.label !== first)!;
  await pick(other.label, other.detail);
  await p.until(`document.querySelector('.pf-title h1')?.innerText.trim() === ${JSON.stringify(other.label)}`, 5000).catch(() => {});
  check((await heroName()) === other.label, 'a handle chosen names them', { want: other.label, got: await heroName() });
  const saved = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())).persons.find((x: any) => x.id === kit.id);
  check(saved?.name === other.label && saved?.nameFrom?.field === 'handle', 'the hub keeps it', { name: saved?.name, nameFrom: saved?.nameFrom });
  await click('.pf-name-swap');
  await menuOpen();
  names = await items();
  check(names.find((n) => n.on)?.label === other.label && !names[0].on, 'opened again, it is the one ticked', names.filter((n) => n.on));
  await pick(names[0].label, names[0].detail);
  await p.until(`document.querySelector('.pf-title h1')?.innerText.trim() === ${JSON.stringify(first)}`, 5000).catch(() => {});
  check((await heroName()) === first, 'the main account’s name puts it back', await heroName());

  // The picture.
  const pic0 = await heroPic();
  await click('.pf-avatar-view');
  await menuOpen();
  let pics = await items();
  check(pics[0]?.label === 'View Picture', 'View Picture first', pics[0]);
  const choices = await p.eval<string[]>(`[...document.querySelectorAll('.cm-pic')].map((i) => i.getAttribute('src'))`);
  check(choices.length >= 5 && new Set(choices).size === choices.length, 'a picture for each account with one, each once', choices.length);
  check(pics.filter((x) => x.on).length === 1 && pics[1]?.on && pics[1].detail.includes('main account'), 'the main account’s first, ticked', pics.slice(1, 3));
  if (shots) await p.shot(`${shots}/picture-menu.png`);
  const another = pics.slice(2).find((x) => !x.on)!;
  await pick(another.label, another.detail);
  await p.until(`document.querySelector('.pf-avatar img')?.getAttribute('src') !== ${JSON.stringify(pic0)}`, 5000).catch(() => {});
  const pic1 = await heroPic();
  check(pic1 && pic1 !== pic0, 'another account’s picture chosen shows', { pic0: pic0.slice(0, 40), pic1: pic1.slice(0, 40) });
  check((await heroName()) === first, 'and their name stays', await heroName());
  await click('.pf-avatar-view');
  await menuOpen();
  pics = await items();
  check(pics.find((x) => x.on)?.label === another.label, 'opened again, it is the one ticked', pics.filter((x) => x.on));
  await pick('View Picture');
  await p.until(`document.querySelector('.viewer .viewer-img')?.naturalWidth > 0`, 3000).catch(() => {});
  check((await p.eval<string>(`document.querySelector('.viewer .viewer-img')?.getAttribute('src') ?? ''`)) === pic1, 'View Picture opens the one showing');
  await escape();
  await p.until(`!document.querySelector('.viewer')`, 3000);
  await click('.pf-avatar-view');
  await menuOpen();
  pics = await items();
  await pick(pics[1].label, pics[1].detail);
  await p.until(`document.querySelector('.pf-avatar img')?.getAttribute('src') === ${JSON.stringify(pic0)}`, 5000).catch(() => {});
  check((await heroPic()) === pic0, 'the main account’s picture puts it back');

  // One account: its display name and its handle.
  await p.goto(`${hub}/#/p/${solo.id}`);
  await p.until(`!!document.querySelector('.profile-page .pf-name-swap')`, 15000);
  await click('.pf-name-swap');
  await menuOpen();
  const one = await items();
  const i = ids.get(solo.identityIds[0]);
  check(one.length === 2 && one[1].label === i.handle, 'one account: its name, then its handle', one);
  if (shots) await p.shot(`${shots}/one-account-menu.png`);
  await escape();
  await menuShut();

  // A phone: the same as a sheet.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/p/${kit.id}`);
  await p.until(`!!document.querySelector('.profile-page .pf-name-swap')`, 15000);
  await tap('.pf-avatar-view');
  await p.until(`!!document.querySelector('.cm-sheet .cm-pic')`, 3000).catch(() => {});
  check(await p.eval(`document.querySelectorAll('.cm-sheet .cm-pic').length >= 5`), 'on a phone, the pictures in a sheet');
  if (shots) await p.shot(`${shots}/phone-picture-sheet.png`);
  await escape();
  await menuShut().catch(() => {});
  await tap('.pf-name-swap');
  await p.until(`!!document.querySelector('.cm-sheet [role="menuitemradio"], .cm-sheet [role="menuitem"]')`, 3000).catch(() => {});
  check(await p.eval(`document.querySelectorAll('.cm-sheet .cm-detail').length >= 3`), 'and the names');
  if (shots) await p.shot(`${shots}/phone-name-sheet.png`);
  await escape();

  // The demo world's pictures point at network servers a demo hub never reaches (502): not this page's errors.
  const errors = p.errors.filter((e) => !e.includes('502 (Bad Gateway)'));
  check(!errors.length, 'no errors in the page', errors.slice(0, 3));
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
