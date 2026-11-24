/**
 * Choosing a person's name and picture from their profile's hero (namechoices.ts, docs/profile.md "Which account
 * speaks for them"), end to end against a demo hub in headless Chromium: the button beside the name lists the main
 * account's name and each account's nickname, display name and handle; a pick names them, ticked when the menu opens
 * again, and the main account's puts it back. Their picture opens their accounts' pictures full screen, on the one
 * shown, with a row of them to page through and a button that shows the one in view. One account's names on a page of
 * their own. On a phone: the names as a sheet, the pictures swiped through.
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
  // Pictures are long data URLs: their first characters say enough.
  const said = JSON.stringify(detail, (_, v) => (typeof v === 'string' && v.length > 60 ? `${v.slice(0, 40)}…` : v));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${said}` : ''}`);
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
/**
 * A finger across the screen, from x0 to x1 at height y, still before it lifts: one lifted moving starts a fling, and
 * Chrome takes the next tap as stopping that fling, with no click.
 */
const swipe = async (x0: number, x1: number, y: number) => {
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let n = 1; n <= 8; n++) await p.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * n) / 8, y }] });
  await Bun.sleep(150);
  await p.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1, y: y + 1 }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const tapItem = async (label: string, detail: string) => {
  // The sheet slides up: tapped mid-slide, the finger lands where the item no longer is.
  await p.until(`document.getAnimations().every((a) => a.playState !== 'running')`, 3000);
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('.cm-sheet [role^="menuitem"]')].find((b) => (b.querySelector('.cm-two > .cm-text') ?? b.querySelector('.cm-text'))?.textContent.trim() === ${JSON.stringify(label)} && b.querySelector('.cm-detail')?.textContent.trim() === ${JSON.stringify(detail)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  if (!r) throw new Error(`no sheet item ${label} ${detail}`);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [r] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
/** The viewer closed, and the history entry it held given back: a page change before that is undone by it. */
const viewerGone = () => p.until(`!document.querySelector('.viewer') && history.state?.layer == null`, 3000);
const escape = () => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
const heroName = () => p.eval<string>(`document.querySelector('.pf-title h1')?.innerText.trim() ?? ''`);
const heroPic = () => p.eval<string>(`document.querySelector('.pf-avatar img')?.getAttribute('src') ?? ''`);
const menuOpen = () => p.until(`!!document.querySelector('[role="menuitemradio"], [role="menuitem"]')`, 3000);
const menuShut = () => p.until(`!document.querySelector('[role="menuitemradio"], [role="menuitem"]')`, 3000);
/** The viewer's pictures to choose from: each one's src, which is in view, which is shown, and the button. */
const viewState = () =>
  p.eval<{ thumbs: { src: string }[]; at: number; on: number; src: string; detail: string; use: string }>(
    `(() => { const t = [...document.querySelectorAll('.viewer-thumb')]; return { thumbs: t.map((b) => ({ src: b.querySelector('img').getAttribute('src') })), at: t.findIndex((b) => b.classList.contains('at')), on: t.findIndex((b) => b.querySelector('.viewer-thumb-on')), src: document.querySelector('.viewer-img')?.getAttribute('src') ?? '', detail: document.querySelector('.viewer-format')?.textContent ?? '', use: document.querySelector('.viewer-use')?.textContent.trim() ?? '' }; })()`,
  );

/** The demo world's notices (an account stopped) would cover the screenshots. */
const shoot = async (file: string) => {
  if (!shots) return;
  await p.eval(`document.getElementById('no-toasts') || document.head.append(Object.assign(document.createElement('style'), { id: 'no-toasts', textContent: '.toasts { display: none !important; }' }))`);
  await p.shot(`${shots}/${file}`);
};

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
  await shoot('name-menu.png');
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

  // The picture: their pictures in the viewer, to choose from.
  const pic0 = await heroPic();
  await click('.pf-avatar-view');
  await p.until(`!!document.querySelector('.viewer .viewer-picks')`, 3000).catch(() => {});
  let view = await viewState();
  check(view.thumbs.length >= 5 && new Set(view.thumbs.map((t) => t.src)).size === view.thumbs.length, 'a picture for each account with one, each once', view.thumbs.length);
  check(view.at === view.on && view.src === pic0 && view.detail.includes('main account'), 'it opens on the one shown, the main account’s, ticked', view);
  check(view.use === 'Shown on their profile', 'and says so', view.use);
  await shoot('picture-viewer.png');
  const k = view.thumbs.findIndex((_, n) => n !== view.on && n > 1);
  await click(`.viewer-thumb:nth-child(${k + 1})`);
  await p.until(`document.querySelector('.viewer-thumb.at') === document.querySelectorAll('.viewer-thumb')[${k}]`, 3000).catch(() => {});
  view = await viewState();
  check(view.at === k && view.src === view.thumbs[k].src && view.use === 'Show This Picture', 'another one in view offers to show it', view);
  await shoot('picture-viewer-other.png');
  await click('.viewer-use');
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Shown')`, 5000).catch(() => {});
  view = await viewState();
  check(view.on === k && view.use === 'Shown on their profile', 'shown, the tick moves to it', view);
  const pic1 = view.thumbs[k].src;
  await escape();
  await viewerGone();
  await p.until(`document.querySelector('.pf-avatar img')?.getAttribute('src') === ${JSON.stringify(pic1)}`, 5000).catch(() => {});
  check((await heroPic()) === pic1, 'their profile shows it', { pic0: pic0.slice(0, 40), pic1: pic1.slice(0, 40) });
  check((await heroName()) === first, 'and their name stays', await heroName());
  await click('.pf-avatar-view');
  await p.until(`!!document.querySelector('.viewer .viewer-picks')`, 3000).catch(() => {});
  view = await viewState();
  check(view.at === k && view.on === k, 'opened again, it opens on that one, ticked', view);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await p.until(`document.querySelector('.viewer-thumb.at') === document.querySelectorAll('.viewer-thumb')[${k - 1}]`, 3000).catch(() => {});
  check((await viewState()).at === k - 1, 'the arrow keys page through them');
  await click('.viewer-thumb:nth-child(1)');
  await click('.viewer-use');
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Shown')`, 5000).catch(() => {});
  await escape();
  await viewerGone();
  await p.until(`document.querySelector('.pf-avatar img')?.getAttribute('src') === ${JSON.stringify(pic0)}`, 5000).catch(() => {});
  check((await heroPic()) === pic0, 'the main account’s picture puts it back');
  const back = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())).persons.find((x: any) => x.id === kit.id);
  check(!back?.pictureIdentityId, 'and the hub clears the choice', back?.pictureIdentityId);

  // One account: its display name and its handle.
  await p.goto(`${hub}/#/p/${solo.id}`);
  // Their page, not the one before it still on its way out.
  await p.until(`!!document.querySelector('.profile-page .pf-name-swap') && document.querySelector('.pf-title h1')?.innerText.trim().split('\\n')[0] === ${JSON.stringify(solo.name)}`, 15000);
  await click('.pf-name-swap');
  await menuOpen();
  const one = await items();
  const i = ids.get(solo.identityIds[0]);
  check(one.length === 2 && one[1].label === i.handle, 'one account: its name, then its handle', one);
  await shoot('one-account-menu.png');
  await escape();
  await menuShut();

  // A phone: the names as a sheet; the pictures full screen, swiped through.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/p/${kit.id}`);
  await p.until(`!!document.querySelector('.profile-page .pf-name-swap') && document.querySelector('.pf-title h1')?.innerText.trim().split('\\n')[0] === ${JSON.stringify(first)}`, 15000);
  await shoot('phone-hero.png');
  await tap('.pf-name-swap');
  await p.until(`!!document.querySelector('.cm-sheet [role^="menuitem"]')`, 3000).catch(() => {});
  check(await p.eval(`document.querySelectorAll('.cm-sheet .cm-detail').length >= 3`), 'on a phone, the names in a sheet');
  await shoot('phone-name-sheet.png');
  const phoneName = names.find((n) => n.detail.startsWith('Display name') && n.label !== first)!;
  await tapItem(phoneName.label, phoneName.detail);
  await p.until(`document.querySelector('.pf-title h1')?.innerText.trim() === ${JSON.stringify(phoneName.label)}`, 5000).catch(() => {});
  check((await heroName()) === phoneName.label, 'a tap names them', { want: phoneName.label, got: await heroName() });
  await tap('.pf-avatar-view');
  await p.until(`!!document.querySelector('.viewer .viewer-picks')`, 3000).catch(() => {});
  const v0 = await viewState();
  check(v0.thumbs.length >= 5 && v0.at === v0.on, 'the pictures full screen, on the one shown');
  await swipe(350, 60, 420);
  await p.until(`document.querySelector('.viewer-thumb.at') === document.querySelectorAll('.viewer-thumb')[${v0.at + 1}]`, 3000).catch(() => {});
  const v1 = await viewState();
  check(v1.at === v0.at + 1 && v1.use === 'Show This Picture', 'a swipe brings the next', v1);
  await shoot('phone-picture-viewer.png');
  await tap('.viewer-use');
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Shown')`, 5000).catch(() => {});
  const mine = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())).persons.find((x: any) => x.id === kit.id);
  check(mine?.avatar === v1.thumbs[v1.at].src, 'a tap shows it', { avatar: mine?.avatar?.slice(0, 40) });
  await escape();

  // The demo world's pictures point at network servers a demo hub never reaches (502): not this page's errors.
  const errors = p.errors.filter((e) => !e.includes('502 (Bad Gateway)'));
  check(!errors.length, 'no errors in the page', errors.slice(0, 3));
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
