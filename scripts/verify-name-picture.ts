/**
 * Choosing a person's name and picture from their profile's hero (namechoices.ts, ui/HeroName.tsx, docs/profile.md
 * "Choosing from the hero"), end to end against a demo hub in headless Chromium: the name, a click copies it, with
 * "×2" where two of their accounts have it; their other names on a line under it, each once and a click copying it;
 * the pencil turns the name into a field with their names under it, the main account's first and once, each with its
 * accounts' marks; a pick names them, ticked when it opens again, and the first row puts it back; a name typed is
 * your nickname for their main account and the name shown. Their picture opens their accounts' pictures full screen,
 * on the one shown, with a row of them to page through and a button that shows the one in view. One account's names
 * on a page of their own. On a phone: the list inside the screen, the pictures swiped through.
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
/** The viewer closed, and the history entry it held given back: a page change before that is undone by it. */
const viewerGone = () => p.until(`!document.querySelector('.viewer') && history.state?.layer == null`, 3000);
const escape = () => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
const PEN = '.pf-name-btn.pen';
const heroName = () => p.eval<string>(`document.querySelector('.pf-name-copy')?.innerText.trim() ?? ''`);
const heroPic = () => p.eval<string>(`document.querySelector('.pf-avatar img')?.getAttribute('src') ?? ''`);
/** The line under the name: each name and its mark. */
const alsoLine = () => p.eval<{ text: string; mark: string }[]>(`[...document.querySelectorAll('.pf-also-it')].map((e) => ({ text: e.querySelector('.pf-also-name').textContent.trim(), mark: e.querySelector('.pf-name-shared')?.textContent.trim() ?? '' }))`);
/** The picker's rows: text, what it is, how many accounts' marks, ticked. */
const rows = () =>
  p.eval<{ text: string; from: string; nets: number; on: boolean }[]>(
    `[...document.querySelectorAll('.pf-name-row')].map((b) => ({ text: b.querySelector('.pf-name-text').textContent.trim(), from: b.querySelector('.pf-name-from').textContent.trim(), nets: b.querySelectorAll('.net-badge').length, on: !!b.querySelector('.pf-name-tick svg') && !b.classList.contains('new') }))`,
  );
/** Clicks (or taps) the picker's row of that text. */
const pickRow = async (text: string, touch = false) => {
  const k = await p.eval<number>(`[...document.querySelectorAll('.pf-name-row')].findIndex((b) => b.querySelector('.pf-name-text').textContent.trim() === ${JSON.stringify(text)})`);
  if (k < 0) throw new Error(`no row ${text}`);
  await (touch ? tap : click)(`.pf-name-row:nth-child(${k + 1})`);
};
const key = async (k: string, code: number) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
};
const editing = () => p.until(`document.activeElement?.matches('.pf-name-field') && !!document.querySelector('.pf-name-row')`, 3000);
const shown = (name: string) => p.until(`document.querySelector('.pf-name-copy')?.innerText.trim() === ${JSON.stringify(name)}`, 5000).catch(() => {});
const api = (path: string, body: unknown) => fetch(`${hub}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const person = async (id: string) => (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())).persons.find((x: any) => x.id === id);
/** What the page last put on the clipboard (headless Chromium has none to read back). */
const stubClipboard = () => p.eval(`(navigator.clipboard.writeText = (t) => ((window.__copied = t), Promise.resolve()), true)`);
const copied = (text: string) => p.until(`window.__copied === ${JSON.stringify(text)}`, 3000).then(() => true, () => false);
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
  await p.until(`!!document.querySelector('.profile-page .pf-name-copy')`, 15000);
  const first = await heroName();
  const kitIds = kit.identityIds.map((id: string) => ids.get(id));
  const mainId = (await person(kit.id)).faceId;
  const handles = new Set(kitIds.map((i: any) => i.handle).filter(Boolean));
  const named = new Set(kitIds.flatMap((i: any) => [i.nickname, i.displayName]).filter(Boolean));

  // The name and the line under it: a click copies each.
  await stubClipboard();
  await click('.pf-name-copy');
  check(await copied(first), 'a click on the name copies it', first);
  const sharing = kitIds.filter((i: any) => i.nickname === first || i.displayName === first || i.handle === first).length;
  const mark = await p.eval<string>(`document.querySelector('.pf-name-line .pf-name-shared')?.textContent.trim() ?? ''`);
  check(sharing > 1 ? mark === `×${sharing}` : mark === '', 'the name says how many of their accounts have it', { sharing, mark });
  let also = await alsoLine();
  check(also.length > 0 && !also.some((a) => a.text === first), 'their other names under it, not the one shown again', also);
  check(new Set(also.map((a) => a.text)).size === also.length, 'each name once on the line', also);
  check(also.every((a) => named.has(a.text) || !handles.has(a.text)), 'no handles on the line', also);
  await click('.pf-also-name');
  check(await copied(also[0].text), 'a click on one copies it', also[0].text);

  // The pencil: the name becomes a field, their names listed under it.
  await click(PEN);
  await editing();
  let list = await rows();
  check(list[0]?.text === first && list[0].on && list[0].from.startsWith("Main account's"), 'the main account’s name first, ticked', list[0]);
  check(list.filter((r) => r.text === first).length === 1, 'and only once, with the accounts that share it', list.filter((r) => r.text === first));
  check(sharing < 2 || list[0].nets === sharing, 'its marks are those accounts’', list[0]);
  check(new Set(list.map((r) => r.text)).size === list.length, 'each name once', list.map((r) => r.text));
  check(list.some((r) => r.from.startsWith('Handle')), 'handles listed too, and said so', list.map((r) => `${r.text} — ${r.from}`));
  check(!list.some((r) => /^\+?[\d\s]+$/.test(r.text)), 'no phone number among them');
  await shoot('name-edit.png');
  const other = list.find((r) => r.from.startsWith('Handle') && r.text !== first)!;
  await pickRow(other.text);
  await shown(other.text);
  check((await heroName()) === other.text, 'a handle picked names them', { want: other.text, got: await heroName() });
  const saved = await person(kit.id);
  check(saved?.name === other.text && saved?.nameFrom?.field === 'handle', 'the hub keeps it', { name: saved?.name, nameFrom: saved?.nameFrom });
  also = await alsoLine();
  check(also.some((a) => a.text === first), 'the main account’s name is on the line now', also);
  await shoot('name-picked.png');
  await click(PEN);
  await editing();
  list = await rows();
  check(list.find((r) => r.on)?.text === other.text && !list[0].on, 'opened again, it is the one ticked', list.filter((r) => r.on));
  await pickRow(first);
  await shown(first);
  check((await heroName()) === first && !(await person(kit.id))?.nameFrom, 'the first row puts the main account’s back', await heroName());

  // Typed: a name none of theirs is your nickname for their main account, and the name shown.
  await click(PEN);
  await editing();
  await p.send('Input.insertText', { text: 'Kit the Tester' });
  await p.until(`document.querySelector('.pf-name-row.new')?.textContent.includes('Kit the Tester')`, 3000).catch(() => {});
  check(await p.eval(`document.querySelector('.pf-name-row')?.matches('.new.hi')`), 'a name typed is offered first, for Enter', await rows());
  await shoot('name-typed.png');
  await key('Enter', 13);
  await shown('Kit the Tester');
  check((await heroName()) === 'Kit the Tester', 'Enter calls them that', await heroName());
  const nicked = await fetch(`${hub}/api/bootstrap`).then((r) => r.json());
  check(nicked.identities.find((i: any) => i.id === mainId)?.nickname === 'Kit the Tester' && !nicked.persons.find((x: any) => x.id === kit.id)?.nameFrom, 'as your nickname for their main account', nicked.persons.find((x: any) => x.id === kit.id)?.name);
  also = await alsoLine();
  check(also.filter((a) => a.text === first).length === 1, 'their own name once on the line', also);
  // Typing filters; Escape leaves the name as it was.
  await click(PEN);
  await editing();
  const part = list.find((r) => r.text !== first && !r.from.startsWith('Handle'))!.text;
  await p.send('Input.insertText', { text: part.slice(1, 4) });
  await p.until(`document.querySelectorAll('.pf-name-row').length < ${list.length}`, 3000).catch(() => {});
  const found = await rows();
  check(found.some((r) => r.text === part) && found.length < list.length, 'typing finds their names', { typed: part.slice(1, 4), found: found.map((r) => r.text) });
  await key('Escape', 27);
  await p.until(`!document.querySelector('.pf-name-field')`, 3000).catch(() => {});
  check((await heroName()) === 'Kit the Tester', 'Escape leaves it as it was', await heroName());
  await api(`/api/identities/${mainId}`, { nickname: null });
  await shown(first);

  // The picture: their pictures in the viewer, to choose from.
  check(await p.eval(`!!document.querySelector('.pf-avatar-view .pf-avatar-badge')`), 'a badge on their picture says there are more to choose from');
  const pic0 = await heroPic();
  await click('.pf-avatar-view');
  await p.until(`!!document.querySelector('.viewer .viewer-picks')`, 3000).catch(() => {});
  let view = await viewState();
  check(view.thumbs.length >= 5 && new Set(view.thumbs.map((t) => t.src)).size === view.thumbs.length, 'a picture for each account with one, each once', view.thumbs.length);
  check(view.at === view.on && view.src === pic0 && view.detail.includes('main account'), 'it opens on the one shown, the main account’s, ticked', view);
  check(view.use === 'Their picture', 'and says so', view.use);
  await shoot('picture-viewer.png');
  const k = view.thumbs.findIndex((_, n) => n !== view.on && n > 1);
  await click(`.viewer-thumb:nth-child(${k + 1})`);
  await p.until(`document.querySelector('.viewer-thumb.at') === document.querySelectorAll('.viewer-thumb')[${k}]`, 3000).catch(() => {});
  view = await viewState();
  check(view.at === k && view.src === view.thumbs[k].src && view.use === 'Use this picture', 'another one in view offers to show it', view);
  await shoot('picture-viewer-other.png');
  await click('.viewer-use');
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Their picture')`, 5000).catch(() => {});
  view = await viewState();
  check(view.on === k && view.use === 'Their picture', 'shown, the tick moves to it', view);
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
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Their picture')`, 5000).catch(() => {});
  await escape();
  await viewerGone();
  await p.until(`document.querySelector('.pf-avatar img')?.getAttribute('src') === ${JSON.stringify(pic0)}`, 5000).catch(() => {});
  check((await heroPic()) === pic0, 'the main account’s picture puts it back');
  const back = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())).persons.find((x: any) => x.id === kit.id);
  check(!back?.pictureIdentityId, 'and the hub clears the choice', back?.pictureIdentityId);

  // One account: its display name and its handle.
  await p.goto(`${hub}/#/p/${solo.id}`);
  // Their page, not the one before it still on its way out.
  await shown(solo.name);
  await click(PEN);
  await editing();
  const one = await rows();
  const i = ids.get(solo.identityIds[0]);
  check(one.length === 2 && one[0].text === solo.name && one[1].text === i.handle && !one[0].from, 'one account: its name, then its handle', one);
  check(!(await alsoLine()).length, 'and nothing on the line under it but a handle, so no line');
  await shoot('one-account-edit.png');
  await key('Escape', 27);

  // A phone: the list inside the screen; the pictures full screen, swiped through.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/p/${kit.id}`);
  await shown(first);
  await shoot('phone-hero.png');
  await tap(PEN);
  await editing();
  const fits = await p.eval<{ right: number; page: number }>(`({ right: document.querySelector('.pf-name-list').getBoundingClientRect().right, page: document.documentElement.scrollWidth })`);
  check(fits.right <= 390 && fits.page <= 390, 'on a phone, the list inside the screen', fits);
  await shoot('phone-name-edit.png');
  const phoneName = list.find((r) => r.text !== first && !r.from)!;
  await pickRow(phoneName.text, true);
  await shown(phoneName.text);
  check((await heroName()) === phoneName.text, 'a tap names them', { want: phoneName.text, got: await heroName() });
  check(await p.eval(`document.documentElement.scrollWidth <= 390`), 'and the line under it wraps inside the screen');
  await tap('.pf-avatar-view');
  await p.until(`!!document.querySelector('.viewer .viewer-picks')`, 3000).catch(() => {});
  const v0 = await viewState();
  check(v0.thumbs.length >= 5 && v0.at === v0.on, 'the pictures full screen, on the one shown');
  await swipe(350, 60, 420);
  await p.until(`document.querySelector('.viewer-thumb.at') === document.querySelectorAll('.viewer-thumb')[${v0.at + 1}]`, 3000).catch(() => {});
  const v1 = await viewState();
  check(v1.at === v0.at + 1 && v1.use === 'Use this picture', 'a swipe brings the next', v1);
  await shoot('phone-picture-viewer.png');
  await tap('.viewer-use');
  await p.until(`document.querySelector('.viewer-use')?.textContent.includes('Their picture')`, 5000).catch(() => {});
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
