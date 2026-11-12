/**
 * The palette (docs/palette.md), end to end against a demo hub in headless Chromium: Ctrl+K and New as one box with
 * pages. The sidebar's + lands on New and Escape closes it; from the root, New… and an action row push their pages,
 * shown as crumbs, and each of Escape, Backspace, a crumb and the back button backs out one page, the root's query
 * still in the box; a name messages someone (straight to a DM, through "which network" and "Message X", by keyboard
 * alone); a pasted demo invite goes to its card and Join, by keyboard alone; Add people from the root (group, people,
 * Ctrl+Enter) and from a group's page, through to an add on the demo hub, and the reason where the account may not;
 * and on a phone: a bottom sheet that fits, no keyboard on a page opened by a tap, the back button one page at a time.
 * Screenshots in a dark and a light theme, at a desktop's width and a phone's.
 *
 *   bun scripts/verify-palette.ts http://127.0.0.1:8821 [/tmp/shots]
 * It joins, opens DMs and adds people in the demo world: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8821';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const convNamed = (network: string, name: string) => boot.conversations.find((c: any) => c.network === network && c.name === name);
const climb = convNamed('signal', 'Climbing crew 🧗');
const family = convNamed('signal', 'Family');
const raid = convNamed('discord', 'weekend raid');
const person = (name: string) => boot.persons.find((p: any) => p.name === name && p.identityIds.length);
const jordan = person('Jordan');
const quinn = person('Quinn');
const dad = person('Dad');
const dmOf = (personId: string, network?: string) => boot.conversations.find((c: any) => c.shape === 'direct' && c.peerPersonId === personId && (!network || c.network === network));
if (!climb || !family || !raid || !jordan || !quinn || !dad || !dmOf(jordan.id) || dmOf(quinn.id) || dmOf(dad.id)) throw new Error('the demo world lacks a place or a person this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}${text ? ` with ${text}` : ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const CODES: Record<string, number> = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
/** A key as a keyboard sends it. modifiers: 2 is Ctrl. */
const key = async (k: string, modifiers = 0) => {
  const code = CODES[k] ?? k.toUpperCase().charCodeAt(0);
  const c = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: c, modifiers, windowsVirtualKeyCode: code, ...(k === 'Enter' && !modifiers ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: c, modifiers, windowsVirtualKeyCode: code });
  await Bun.sleep(120);
};
/** Typed into whatever has focus, as a keyboard would. */
const type = async (s: string) => {
  await p.send('Input.insertText', { text: s });
  await Bun.sleep(150);
};
/** Pasted into the palette's input: a paste event, then the text arriving, as a browser does. */
const paste = async (s: string) => {
  await p.eval(`(() => { const i = document.querySelector('.palette-input'); i.focus(); i.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); })()`);
  await p.send('Input.insertText', { text: s });
  await Bun.sleep(150);
};
const ctrlK = () => key('k', 2);
/** Where the palette is: its page, how many pages deep, the crumbs before the title, the title, the input. */
const at = () =>
  p.eval<{ page: string | null; depth: number; crumbs: string[]; title: string; q: string | null; focus: string }>(`(() => {
    const b = document.querySelector('.palette');
    const i = document.querySelector('.palette-input');
    const a = document.activeElement;
    return {
      page: b?.dataset.page ?? null,
      depth: Number(b?.dataset.depth ?? 0),
      crumbs: [...document.querySelectorAll('.palette-crumb')].map((c) => c.classList.contains('palette-crumb-root') ? '⌕' : c.textContent),
      title: document.querySelector('.palette-title')?.textContent ?? '',
      q: i ? i.value : null,
      focus: a === i ? 'input' : a === b ? 'box' : a?.tagName === 'BODY' ? 'body' : (a?.className ?? a?.tagName ?? ''),
    };
  })()`);
// The page drawn: the box says which, and the page's frame is there (the pages' chunk may still be loading at first).
const pageIs = (page: string | null, ms = 4000) => p.until(page ? `document.querySelector('.palette')?.dataset.page === ${JSON.stringify(page)} && !!document.querySelector('.palette .palette-page')` : `!document.querySelector('.palette')`, ms);
const rowKeys = () => p.eval<string[]>(`[...document.querySelectorAll('.palette [data-row]')].map((r) => r.dataset.key)`);
const activeKey = () => p.eval<string>(`document.querySelector('.palette [data-row].active')?.dataset.key ?? ''`);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
const load = async (path: string, ready = '.side-new') => {
  await p.goto('about:blank');
  await p.goto(`${hub}/${path}`);
  await p.until(`!!document.querySelector(${JSON.stringify(ready)})`, 20000);
};
const setTheme = (theme: string) => p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(theme)} }))`);

try {
  await p.size(1280, 820);
  await load('#/inbox');

  // 1. The sidebar's + lands on New; Escape closes it.
  await click('.side-new');
  await pageIs('new');
  let s = await at();
  check(s.depth === 1 && s.title === 'New' && s.crumbs.join() === '⌕' && s.focus === 'input' && s.q === '', 'the + opens the palette at New, its bottom page, the input ready', s);
  const menu = await rowKeys();
  check(menu.slice(0, 4).join() === 'n:add,n:group,n:scan,n:mine' && menu.length > 5, 'New with nothing typed: Add people to a group, New group, Scan a code, My code, then people', menu);
  await shot('palette-01-new');
  await key('Escape');
  await pageIs(null);
  check(!(await has('.palette')), 'Escape on the bottom page closes it');

  // 2. The root: New… last; pages pushed and backed out of, four ways, the root's query kept.
  await ctrlK();
  await pageIs('root');
  s = await at();
  const rootRows = await rowKeys();
  check(s.depth === 1 && !s.crumbs.length && s.focus === 'input' && rootRows.at(-1) === 'new', 'Ctrl+K opens the root: no crumbs, New… its last row', { ...s, last: rootRows.at(-1) });
  await key('ArrowUp');
  check((await activeKey()) === 'new', 'the arrows go round to New…', await activeKey());
  await key('Enter');
  await pageIs('new');
  s = await at();
  check(s.depth === 2 && s.crumbs.join() === '⌕' && s.title === 'New' && s.focus === 'input', 'Enter on New… pushes New: a crumb back to the root before it', s);
  await key('Escape');
  await pageIs('root');
  check((await at()).depth === 1, '1 of 4: Escape backs out to the root');

  await type('my code');
  check((await activeKey()) === 'a:mine', 'typed, the root offers My code first', await rowKeys());
  await key('Enter');
  await pageIs('mine');
  s = await at();
  check(s.title === 'My code' && s.q === null && s.focus === 'box' && s.depth === 2, 'My code is a page with a body and no input; the box has the keys', s);
  await key('Backspace');
  await pageIs('root');
  check((await at()).q === 'my code', '2 of 4: Backspace backs out, and what was typed at the root is still there', await at());
  await key('Enter');
  await pageIs('mine');
  await click('.palette-crumb-root');
  await pageIs('root');
  check((await at()).q === 'my code', '3 of 4: the root crumb backs out to it, the query kept', await at());
  await key('Enter');
  await pageIs('mine');
  await p.eval('history.back()');
  await pageIs('root');
  check((await at()).q === 'my code', '4 of 4: the back button backs out one page', await at());
  await p.eval('history.back()');
  await pageIs(null);
  check(true, 'and once more closes it');

  // Two pages up: Backspace in the empty input backs out one; a crumb goes back two.
  await ctrlK();
  await pageIs('root');
  await type('add people');
  await key('Enter');
  await pageIs('groups');
  s = await at();
  check(s.title === 'Add people to a group' && s.crumbs.join() === '⌕' && s.q === '', 'Add people to a group from the root: a page of its own, starting empty', s);
  const groups = await rowKeys();
  check(groups.includes(climb.id) && groups.includes(family.id) && groups.includes(raid.id) && !groups.includes(convNamed('whatsapp', 'Book club 📚').id), 'it lists the groups an account could add to, not WhatsApp’s', groups.length);
  await type('climb');
  check((await rowKeys()).join() === climb.id, 'typing narrows the groups', await rowKeys());
  await key('Enter');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  s = await at();
  check(s.depth === 3 && s.crumbs.join() === '⌕,Add people to a group' && s.title.startsWith('Add people to Climbing crew'), 'the picker: crumbs for every page under it', s);
  await shot('palette-02-picker');
  await key('Backspace');
  await pageIs('groups');
  check((await at()).q === 'climb', 'Backspace in the empty input backs out one page; the group search kept', await at());
  await key('Enter');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  await click('.palette-crumb', 'Add people to a group');
  await pageIs('groups');
  await key('Escape');
  await pageIs('root');
  check((await at()).q === 'add people', 'and Escape back to the root, its query kept', await at());

  // 3. Add people from the root, by keyboard alone: pick, un-pick with Backspace, pick, Ctrl+Enter.
  await key('Enter');
  await pageIs('groups');
  await type('climb');
  await key('Enter');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  await type('qui');
  check((await p.eval<string[]>(`[...document.querySelectorAll('.add-mem .fwd-row b')].map((b) => b.textContent)`)).join() === 'Quinn', 'typing searches the people', await text('.add-mem .fwd-row b'));
  await key('Enter');
  check((await text('.add-mem .fwd-chip')) === 'Quinn', 'Enter picks the row', await text('.add-mem .fwd-chip'));
  for (let i = 0; i < 3; i++) await key('Backspace');
  check((await at()).q === '' && (await text('.add-mem .fwd-chip')) === 'Quinn', 'Backspace deletes what was typed first', await at());
  await key('Backspace');
  check(!(await has('.add-mem .fwd-chip')) && (await at()).page === 'add', 'then, in the empty input, un-picks the last one, staying on the page');
  await type('qui');
  await key('Enter');
  check((await p.eval<string>(`document.querySelector('.add-mem-send .btn').textContent`)).trim() === 'Add' && (await text('.add-mem .pick-count')) === '1 picked', 'picked again: the count and Add', await text('.add-mem-send'));
  await key('Enter', 2);
  await pageIs(null, 10000);
  await p.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Added Quinn'))`, 4000).catch(() => {});
  check((await text('.toast')).includes('Added Quinn'), 'Ctrl+Enter adds them, and the palette closes', await text('.toast'));
  const after = await fetch(`${hub}/api/conversations/${climb.id}/about`).then((r) => r.json() as Promise<any>);
  check(after.members.list.some((m: any) => quinn.identityIds.includes(m.identityId)), 'the demo hub has Quinn in the group', after.members.list.length);

  // A group where this account may not add: the reason, and nothing offered.
  await ctrlK();
  await type('add people');
  await key('Enter');
  await pageIs('groups');
  await type('family');
  await key('Enter');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem-reason')`, 10000);
  check((await text('.add-mem-reason')).includes('Only admins can add members') && !(await has('.add-mem .fwd-row')) && !(await has('.add-mem-send')) && (await at()).q === null, 'where the About says no: its reason, no input, no rows, no button', await text('.add-mem-reason'));
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await pageIs(null);

  // 4. Add people from a group's page: the picker is the bottom page; an add refreshes the page's members.
  await load(`#/about/c/${raid.id}`, '.about-members .about-add-people');
  await click('.about-members .about-add-people');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  s = await at();
  check(s.depth === 1 && s.crumbs.join() === '⌕' && s.title.startsWith('Add people to'), 'a group’s Add people opens the palette at the picker, its bottom page', s);
  await key('Escape');
  await pageIs(null);
  check(!(await has('.palette')), 'Escape closes it there');
  await Bun.sleep(300);
  await click('.about-members .about-add-people');
  await p.until(`!!document.querySelector('.add-mem .fwd-row:not(:disabled)')`, 10000);
  const friend = await p.eval<string>(`document.querySelector('.add-mem .fwd-row:not(:disabled) b').textContent`);
  await click('.add-mem .fwd-row', friend);
  await click('.add-mem-send .btn');
  await pageIs(null, 10000);
  await p.until(`[...document.querySelectorAll('.about-members .member b')].some((b) => b.textContent === ${JSON.stringify(friend)})`, 6000).catch(() => {});
  check(await p.eval(`[...document.querySelectorAll('.about-members .member b')].some((b) => b.textContent === ${JSON.stringify(friend)})`), 'Add on the picker: the page’s About shows them as a member', friend);

  // 5. A name: someone with a DM goes straight there.
  await load('#/inbox');
  await click('.side-new');
  await pageIs('new');
  await type('jordan');
  check((await activeKey()) === jordan.id, 'a name: that person is the first row', await rowKeys());
  await key('Enter');
  await pageIs(null);
  await Bun.sleep(300);
  check((await hash()).includes(dmOf(jordan.id).id), 'Enter on someone you have a DM with goes there', await hash());

  // Someone on two networks with no DM, by keyboard alone: which network, then "Message X", then open it.
  await click('.side-new');
  await pageIs('new');
  await type('quinn');
  await key('Enter');
  await pageIs('reach');
  s = await at();
  const nets = await p.eval<string[]>(`[...document.querySelectorAll('.palette [data-row]')].map((r) => r.dataset.network)`);
  check(s.title === 'Message Quinn' && s.crumbs.join() === '⌕,New' && nets.join() === 'discord,signal', 'on two networks: a page to choose which', { ...s, nets });
  await key('ArrowDown');
  await key('Enter');
  await pageIs('message');
  s = await at();
  check(s.title === 'Message Quinn on Signal' && s.crumbs.join() === '⌕,New,Message Quinn' && (await has('.palette .new-message-open')), '"Message Quinn on Signal": a page with Open conversation', s);
  await shot('palette-03-message');
  await key('Enter');
  await pageIs(null, 8000);
  await Bun.sleep(400);
  const opened = (await bootstrap()).conversations.find((c: any) => c.shape === 'direct' && c.network === 'signal' && c.peerPersonId === quinn.id);
  check(opened && (await hash()).includes(opened.id), 'Enter opens the conversation', { hash: await hash(), dm: opened?.id });

  // 6. A pasted demo invite: its card at once; Backspace back to New with the link; Enter looks it up again; Tab to Join.
  await click('.side-new');
  await pageIs('new');
  await paste('https://discord.gg/pixelart');
  await pageIs('card');
  await p.until(`!!document.querySelector('.add-card-name') && !document.querySelector('.add-loading')`, 8000);
  s = await at();
  check(s.depth === 2 && s.crumbs.join() === '⌕,New' && s.title === 'Discord invite discord.gg/pixelart' && (await text('.add-card-name')) === 'Pixel Art Club', 'a pasted invite: its card, a page on New', s);
  await shot('palette-04-card');
  await key('Backspace');
  await pageIs('new');
  check((await at()).q === 'https://discord.gg/pixelart', 'Backspace: New, the link still in the box', await at());
  await key('Enter');
  await pageIs('card');
  await p.until(`!!document.querySelector('.add-card-name') && !document.querySelector('.add-loading')`, 8000);
  let tabs = 0;
  while (tabs < 8 && !(await p.eval(`document.activeElement?.dataset?.action === 'join'`))) {
    await key('Tab');
    tabs++;
  }
  check(await p.eval(`document.activeElement?.dataset?.action === 'join'`), 'Tab is not swallowed: it reaches Join', tabs);
  await key('Enter');
  await pageIs(null, 8000);
  await Bun.sleep(400);
  const space = (await bootstrap()).spaces.find((x: any) => x.name === 'Pixel Art Club');
  check(space && (await hash()).startsWith(`#/s/${space.id}`), 'Enter on Join joins, and lands in the server', await hash());

  // A click beside the box closes it whole.
  await ctrlK();
  await type('add people');
  await key('Enter');
  await pageIs('groups');
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1250, y: 790, button: 'left', clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1250, y: 790, button: 'left', clickCount: 1 });
  await pageIs(null);
  check(!(await has('.palette')), 'a click beside the box closes it whole');

  // 7. A light theme.
  await setTheme('dither-light');
  await load('#/inbox');
  check((await p.eval(`document.documentElement.dataset.theme`)) === 'light', 'a light theme is on');
  await click('.side-new');
  await pageIs('new');
  await shot('palette-05-new-light');
  await click('.palette [data-key="n:add"]');
  await pageIs('groups');
  await click('.palette [data-row]', 'Housemates');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  await click('.add-mem .fwd-row');
  await shot('palette-06-picker-light');
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await pageIs(null);
  await setTheme('dither-dark');

  // 8. On a phone: a bottom sheet that fits; the back button one page at a time.
  await p.size(390, 844, true);
  await load('#/inbox');
  await click('.side-new');
  await pageIs('new');
  await Bun.sleep(400); // the sheet slides up
  const fit = await p.eval<{ w: number; bottom: number; h: number; scroll: number; inside: boolean }>(
    `(() => { const b = document.querySelector('.palette'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), bottom: Math.round(r.bottom), h: innerHeight, scroll: document.documentElement.scrollWidth, inside: b.scrollWidth <= b.clientWidth + 1 }; })()`,
  );
  check(fit.w === 390 && Math.abs(fit.bottom - fit.h) <= 1 && fit.scroll <= 390 && fit.inside, 'on a phone New is a bottom sheet, full width, nothing sideways', fit);
  check((await at()).focus === 'input', 'New is about typing: its input has focus, as the New box did');
  check((await p.eval(`document.querySelector('.palette-input').placeholder`)) === 'Name, link, @name or phone', 'its placeholder is the short one, whole');
  await shot('palette-07-phone-new');
  await click('.palette [data-key="n:add"]');
  await pageIs('groups');
  s = await at();
  check(s.focus !== 'input' && s.depth === 2, 'a page opened by a tap that is not about typing: no keyboard', s);
  await click('.palette [data-row]', 'Climbing crew');
  await pageIs('add');
  await p.until(`!!document.querySelector('.add-mem .fwd-row')`, 10000);
  await Bun.sleep(300);
  const pick = await p.eval<{ w: number; bottom: number; h: number; scroll: number; inside: boolean; focus: boolean }>(
    `(() => { const b = document.querySelector('.palette'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), bottom: Math.round(r.bottom), h: innerHeight, scroll: document.documentElement.scrollWidth, inside: b.scrollWidth <= b.clientWidth + 1, focus: document.activeElement?.classList.contains('palette-input') }; })()`,
  );
  check(pick.w === 390 && Math.abs(pick.bottom - pick.h) <= 1 && pick.scroll <= 390 && pick.inside && !pick.focus, 'the picker on a phone: fits, no keyboard unasked', pick);
  const head = await p.eval<{ chevron: boolean; crumbs: number; title: string; whole: boolean }>(
    `(() => { const t = document.querySelector('.palette-title'); return { chevron: !!document.querySelector('.palette-back-btn'), crumbs: document.querySelectorAll('.palette-crumb').length, title: t.textContent, whole: t.scrollWidth <= t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1 }; })()`,
  );
  check(head.chevron && !head.crumbs && head.title.includes('Climbing crew') && head.whole, 'on a phone: a back chevron in place of the crumbs, and the title whole', head);
  await shot('palette-08-phone-picker');
  await p.eval('history.back()');
  await pageIs('groups');
  check((await at()).depth === 2, 'the back button: one page back');
  await p.eval('history.back()');
  await pageIs('new');
  check((await at()).depth === 1, 'and another');
  await click('.palette-back-btn');
  await pageIs('root');
  check((await at()).depth === 1, 'the chevron on the bottom page reaches Ctrl+K’s root on a phone');
  await p.eval('history.back()');
  await pageIs(null);
  check(!(await has('.palette')), 'and the back button at the bottom page closes it');
  await Bun.sleep(300);
  check((await hash()) === '#/inbox', 'leaving the page where it was', await hash());
  await click('.side-new');
  await pageIs('new');
  await paste('https://t.me/+FilmSwap2026x');
  await pageIs('card');
  await p.until(`!!document.querySelector('.add-card-name') && !document.querySelector('.add-loading')`, 8000);
  const card = await p.eval<{ right: number; scroll: number; inside: boolean }>(`(() => { const b = document.querySelector('.palette'); return { right: b.getBoundingClientRect().right, scroll: document.documentElement.scrollWidth, inside: b.scrollWidth <= b.clientWidth + 1 }; })()`);
  check(card.right <= 391 && card.scroll <= 391 && card.inside, 'a card on a phone fits', card);
  await shot('palette-09-phone-card');
  await p.eval('history.back()');
  await pageIs('new');
  await p.eval('history.back()');
  await pageIs(null);

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
