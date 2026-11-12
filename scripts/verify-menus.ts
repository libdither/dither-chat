/**
 * Right-click menus and forwarding, end to end against a demo hub, in headless Chromium: desktop menus by
 * mouse and keyboard, Shift+right-click left alone, the menu kept inside the window, a triaged message's two marks
 * ("Should have alerted", "Less like this") as ticked entries, a channel's notification rule (Automatic, Always
 * alert, List only, Mute), the forward dialog, both kinds of forward arriving, and the phone's long-press sheet with
 * the marks under the reasons.
 *
 *   bun scripts/verify-menus.ts http://127.0.0.1:8531 /tmp/shots
 * The hub must be a demo hub (--demo) with its own data dir: this sends messages, marks one and sets a rule.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8531';
const shots = process.argv[3] ?? '/tmp/dither-menu-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const conv = (net: string, name: string, accounts?: number) => boot.conversations.find((c: any) => c.network === net && c.name === name && (!accounts || c.vantages.length === accounts));
const general = conv('discord', 'general', 2);
const dev = conv('discord', 'dev');
const nixdev = conv('matrix', 'Nix Development');
const dither = boot.spaces.find((s: any) => s.name === 'libdither');

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const b = await launch();
const p: Page = b.page;

async function mouse(type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none', modifiers = 0) {
  await p.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers });
}
async function rightClick(x: number, y: number, modifiers = 0) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'right', modifiers);
  await mouse('mouseReleased', x, y, 'right', modifiers);
  await Bun.sleep(120);
}
async function click(x: number, y: number) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'left');
  await mouse('mouseReleased', x, y, 'left');
  await Bun.sleep(120);
}
async function key(k: string, code = k) {
  const text = k.length === 1 ? k : undefined;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Escape: 27, Enter: 13 }[k] ?? k.toUpperCase().charCodeAt(0) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  await Bun.sleep(80);
}
const center = (sel: string) => p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const labels = (sel = '.cm:last-of-type') => p.eval<string[]>(`[...document.querySelectorAll('${sel} .cm-item, ${sel} .cm-sep, ${sel} .cm-row')].map((e) => e.classList.contains('cm-sep') ? '—' : e.classList.contains('cm-row') ? '[quick reactions]' : e.querySelector('.cm-text').textContent + (e.classList.contains('danger') ? ' (red)' : '') + (e.querySelector('.cm-hint') ? ' [' + e.querySelector('.cm-hint').textContent + ']' : ''))`);
const menuOpen = () => p.eval<number>(`document.querySelectorAll('.cm').length`);
/** `within`: only items under this selector (a submenu), where the menu above it has one that starts the same. */
const clickItem = async (label: string, within = '') => {
  const at = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('${within} .cm-item, ${within} .sheet-action')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`no item ${label}`);
  await click(at.x, at.y);
};

// ------------------------------------------------------------------ desktop
await p.size(1280, 800);
await p.goto(`${hub}/#/s/${dither.id}/c/${general.id}`);
await p.until(`document.querySelectorAll('.msg:not(.system) .msg-body').length > 2`, 15000);
const msgSel = `.msg:not(.system):not(.pending) .msg-body`;
let at = (await center(msgSel))!;
await rightClick(at.x, at.y);
check((await menuOpen()) === 1, 'right-click on a message opens one menu');
const msgItems = await labels();
console.log('     message menu:', msgItems.join(' | '));
check(msgItems.includes('Forward [F]') && msgItems.includes('Copy Message ID') && msgItems.includes('[quick reactions]'), 'the message menu has reactions, Forward and the ID');
await p.shot(join(shots, 'desktop-message-menu.png'));

// keyboard: down to Add Reaction, right opens its submenu, left closes it, escape closes the menu
await key('ArrowDown');
const active = () => p.eval<string>(`document.querySelector('.cm-item.active .cm-text')?.textContent ?? ''`);
check((await active()) === 'Add Reaction', 'ArrowDown reaches the first item');
await key('ArrowRight');
check((await menuOpen()) === 2, 'ArrowRight opens the submenu');
await key('ArrowLeft');
check((await menuOpen()) === 1, 'ArrowLeft closes only the submenu');
await key('ArrowUp');
check((await active()) === 'Copy dither-chat ID', 'ArrowUp wraps to the last item');
await key('Escape');
check((await menuOpen()) === 0, 'Escape closes the menu');

// Shift+right-click is the browser's
await rightClick(at.x, at.y, 8);
check((await menuOpen()) === 0, 'Shift+right-click opens no menu of ours');

// kept inside the window
const corner = await p.eval<{ x: number; y: number }>(`(() => { const ms = [...document.querySelectorAll('.msg:not(.system):not(.pending)')]; const r = ms[ms.length - 1].getBoundingClientRect(); return { x: Math.min(innerWidth - 4, r.right - 4), y: r.bottom - 4 }; })()`);
await rightClick(corner.x, corner.y);
const box = await p.eval<{ l: number; t: number; r: number; b: number } | null>(`(() => { const r = document.querySelector('.cm')?.getBoundingClientRect(); return r && { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
check(box && box.r <= 1280 && box.b <= 800 && box.l >= 0 && box.t >= 0, `a menu opened in the corner stays inside the window (${JSON.stringify(box)})`);
await click(400, 300);
check((await menuOpen()) === 0, 'a click outside closes it');

// a channel in the sidebar, with the notification submenu by hover
at = (await center('.chan.active'))!;
await rightClick(at.x, at.y);
const chanItems = await labels();
console.log('     channel menu:', chanItems.join(' | '));
check(chanItems[0].startsWith('Mark As Read') && chanItems.some((l) => l.startsWith('Notification Settings')) && chanItems.includes('Copy Channel ID'), 'the channel menu');
const notif = await p.eval<{ x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.cm-item')].find((b) => b.textContent.startsWith('Notification Settings')); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
await mouse('mouseMoved', notif.x, notif.y);
await Bun.sleep(300);
check((await menuOpen()) === 2, 'hovering Notification Settings opens its submenu');
const rules = await labels('.cm-sub');
console.log('     notification submenu:', rules.join(' | '));
const ruleOf = async () => (await fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as any).rules.find((r: any) => r.scope === 'conversation' && r.target === general.id)?.level ?? null;
/** The submenu's ticked entry, and the line under Automatic. */
const chosen = () => p.eval<{ on: string[]; note: string }>(`({ on: [...document.querySelectorAll('.cm-sub .cm-item[aria-checked=true]')].map((e) => e.querySelector('.cm-text').textContent), note: document.querySelector('.cm-sub .cm-label.note')?.textContent ?? '' })`);
check(rules.join() === 'Automatic,—,Always alert,List only,Mute', 'its choices are Automatic, then Always alert, List only and Mute');
let now = await chosen();
check(now.on.join() === 'Automatic' && now.note === 'Discord notifies only mentions here', `Automatic is chosen, with what the network does here under it (${JSON.stringify(now)})`);
await p.shot(join(shots, 'desktop-channel-menu.png'));
await clickItem('List only', '.cm-sub');
await Bun.sleep(400);
check((await ruleOf()) === 'digest', 'choosing List only sets the rule on the hub');
await rightClick(at.x, at.y);
await mouse('mouseMoved', notif.x, notif.y);
await Bun.sleep(300);
now = await chosen();
check(now.on.join() === 'List only' && now.note === '', `the submenu then has List only chosen, and no line under Automatic (${JSON.stringify(now)})`);
await clickItem('Mute', '.cm-sub');
await Bun.sleep(400);
check((await ruleOf()) === 'none', 'choosing Mute sets the rule on the hub');
await rightClick(at.x, at.y);
check((await labels()).includes('Unmute Channel'), 'a muted channel offers Unmute');
await clickItem('Unmute Channel');
await Bun.sleep(300);
check((await ruleOf()) === null, 'Unmute takes the rule away: Automatic again');

// a triaged message from someone else: the two marks, ticked entries in a group of their own
const triaged = ((await fetch(`${hub}/api/inbox`).then((r) => r.json())) as any).items.map((i: any) => i.message).find((m: any) => m.triage?.decision === 'quiet' && !m.triage.marks);
const marksOf = async () => ((await fetch(`${hub}/api/inbox`).then((r) => r.json())) as any).items.find((i: any) => i.message.id === triaged.id)?.message.triage.marks ?? {};
await p.goto(`${hub}/#/inbox/c/${triaged.conversationId}?m=${triaged.id}`);
await p.until(`!!document.querySelector('#m-${triaged.id} .msg-body')`, 15000);
await Bun.sleep(400);
const markAt = (await center(`#m-${triaged.id} .msg-body`))!;
/** The marks in the open menu: each entry's words and whether it is ticked. */
// (Reply marks, "No reply needed" and "Reply needed", are a group of their own before them: verify-reply-marks.ts.)
const marksShown = () => p.eval<string[]>(`[...document.querySelectorAll('.cm .cm-item[role=menuitemcheckbox]')].map((e) => e.querySelector('.cm-text').textContent + (e.getAttribute('aria-checked') === 'true' ? ' ✓' : '')).filter((t) => !/^(No reply needed|Reply needed)/.test(t))`);
await rightClick(markAt.x, markAt.y);
const withMarks = await labels();
console.log('     triaged message menu:', withMarks.join(' | '));
const mi = withMarks.indexOf('Should have alerted');
check(mi > 0 && withMarks[mi - 1] === '—' && withMarks[mi + 1] === 'Less like this' && withMarks[mi + 2] === '—', 'a triaged message has "Should have alerted" and "Less like this" in a group of their own');
check((await marksShown()).join() === 'Should have alerted,Less like this', 'neither is ticked at first');
check(!withMarks.some((l) => /Important|Active|Digest|Not interesting/.test(l)), 'and no level to vote it to');
await p.shot(join(shots, 'desktop-message-marks.png'));
await clickItem('Less like this');
await Bun.sleep(500);
check((await menuOpen()) === 0 && (await marksOf()).less === true, 'choosing "Less like this" closes the menu and marks it on the hub');
await rightClick(markAt.x, markAt.y);
check((await marksShown()).join() === 'Should have alerted,Less like this ✓', 'the menu then shows it ticked');
await clickItem('Less like this');
await Bun.sleep(500);
check((await marksOf()).less === undefined, 'choosing the ticked one takes the mark back');
await rightClick(markAt.x, markAt.y);
await clickItem('Should have alerted');
await Bun.sleep(500);
check((await marksOf()).alert === true, '"Should have alerted" marks it on the hub');
await rightClick(markAt.x, markAt.y);
check((await marksShown()).join() === 'Should have alerted ✓,Less like this', 'and shows ticked');
await clickItem('Should have alerted');
await Bun.sleep(500);
check((await marksOf()).alert === undefined, 'and is taken back the same way');
await p.goto(`${hub}/#/s/${dither.id}/c/${general.id}`);
await p.until(`document.querySelectorAll('.msg:not(.system) .msg-body').length > 2`, 15000);

// the server in the rail, the accounts button
at = (await center(`.rail-item[data-dnd-key^="space:"] .rail-btn`))!;
await rightClick(at.x, at.y);
const spaceItems = await labels();
console.log('     server menu:', spaceItems.join(' | '));
check(spaceItems.some((l) => /^Mute (Server|Space)$/.test(l)) && spaceItems.some((l) => /^Copy (Server|Space) ID$/.test(l)), 'the server menu');
await key('Escape');
at = (await center(`.rail-foot .rail-btn[aria-label="Accounts and connections"]`))!;
await rightClick(at.x, at.y);
const accItems = await labels();
console.log('     accounts menu:', accItems.join(' | '));
check(accItems.some((l) => l.startsWith('Discord · main')), 'the accounts menu lists accounts');
await key('Escape');

// a person
at = (await center(`.msg:not(.system) .msg-author`))!;
await rightClick(at.x, at.y);
const personItems = await labels();
console.log('     person menu:', personItems.join(' | '));
check(personItems[0] === 'Profile' && personItems.includes('Copy') && !personItems.some((l) => /^(Star|Unstar|Copy from)/.test(l)), 'the person menu: one Copy entry, no star');
await key('Escape');

// ------------------------------------------------------------------ forwarding
// The demo seeds a forward in #dev: Lev forwarded the announcement.
await p.goto(`${hub}/#/s/${dither.id}/c/${dev.id}`);
await p.until(`document.querySelector('.fwd-card') !== null`, 10000);
check(await p.eval(`document.querySelector('.fwd-card .fwd-card-src')?.textContent.includes('announcements')`), 'an incoming Discord forward shows as a card with where it came from');
await p.shot(join(shots, 'desktop-incoming-forward.png'));

// Forward a message from #general to #dev (native, demo) and to Housemates on Matrix (cross-network).
await p.goto(`${hub}/#/s/${dither.id}/c/${general.id}`);
await p.until(`document.querySelectorAll('.msg:not(.system) .msg-body').length > 2`, 10000);
at = (await center(msgSel))!;
const original = await p.eval<string>(`document.querySelector(${JSON.stringify(msgSel)}).textContent`);
await rightClick(at.x, at.y);
await key('f');
await p.until(`document.querySelector('.fwd') !== null`, 3000);
check(true, 'F in the menu opens the forward dialog');
const pick = async (q: string) => {
  await p.eval(`(() => { const i = document.querySelector('.fwd-search input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(150);
  const ok = await p.eval<boolean>(`(() => { const r = [...document.querySelectorAll('.fwd-row:not(:disabled)')].find((r) => r.querySelector('b').textContent.replace(/^#/, '') === ${JSON.stringify(q)}); r?.click(); return !!r; })()`);
  if (!ok) throw new Error(`no destination named ${q}`);
  await Bun.sleep(100);
};
await pick('dev');
await pick('Nix Development');
await p.eval(`(() => { const i = document.querySelector('.fwd-note'); i.value = 'forward test note'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await Bun.sleep(100);
await p.eval(`(() => { const i = document.querySelector('.fwd-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await Bun.sleep(150);
const hows = await p.eval<string[]>(`[...document.querySelectorAll('.fwd-row.on .fwd-how')].map((e) => e.textContent)`);
check(hows.sort().join() === 'Copy to Matrix,Forward', `the dialog says how each will go (${hows.join(', ')})`);
await p.shot(join(shots, 'desktop-forward-dialog.png'));
await p.eval(`document.querySelector('.fwd-send .btn.primary').click()`);
await p.until(`document.querySelector('.fwd') === null`, 8000);
check(true, 'sending closes the dialog');

await p.goto(`${hub}/#/s/${dither.id}/c/${dev.id}`);
await p.until(`[...document.querySelectorAll('.fwd-card')].some((c) => c.textContent.includes(${JSON.stringify(original.slice(0, 20))}))`, 8000);
check(await p.eval(`[...document.querySelectorAll('.msg-body')].some((b) => b.textContent === 'forward test note')`), 'the native forward arrives with its note after it');
await p.shot(join(shots, 'desktop-native-forward.png'));

await p.goto(`${hub}/#/inbox/c/${nixdev.id}`);
await p.until(`[...document.querySelectorAll('.fwd-card')].some((c) => c.textContent.includes(${JSON.stringify(original.slice(0, 20))}))`, 8000);
const cross = await p.eval<string>(`[...document.querySelectorAll('.fwd-card')].pop().textContent`);
check(cross.includes('Discord') && cross.includes('general'), `the cross-network forward shows its source (${cross.slice(0, 120)})`);
check(await p.eval(`[...document.querySelectorAll('.msg-body')].some((b) => b.textContent === 'forward test note')`), 'its note shows above the card');
await p.shot(join(shots, 'desktop-cross-forward.png'));
const sent = await fetch(`${hub}/api/conversations/${nixdev.id}/messages?limit=5`).then((r) => r.json()) as any;
const last = sent.messages.at(-1);
console.log('     what Matrix got:', JSON.stringify(last.body));
check(last.body.startsWith('forward test note\n\n↪ Forwarded from **') && last.forward?.sentAs === 'cross', 'Matrix got the note, the attribution line and the quote');

// ------------------------------------------------------------------ phone
await p.size(390, 844, true);
await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await p.goto(`${hub}/#/s/${dither.id}/c/${general.id}`);
await p.until(`document.querySelectorAll('.msg:not(.system) .msg-body').length > 2`, 10000);
at = (await center(msgSel))!;
await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
await Bun.sleep(650);
await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await Bun.sleep(400);
const sheet = await p.eval<string[]>(`[...document.querySelectorAll('.cm-sheet .sheet-action')].map((b) => b.textContent.trim())`);
console.log('     phone sheet:', sheet.join(' | '));
check(sheet.includes('Forward') && (await p.eval(`!!document.querySelector('.cm-sheet .msg-sheet-head') && !!document.querySelector('.cm-sheet .sheet-quick')`)), 'a long press opens the same menu as a sheet, with the message and quick reactions on top');
await p.shot(join(shots, 'phone-message-sheet.png'));
await p.eval(`[...document.querySelectorAll('.cm-sheet .sheet-action')].find((b) => b.textContent.trim() === 'Add Reaction').click()`);
await Bun.sleep(200);
check(await p.eval(`!!document.querySelector('.cm-sheet-back')`), 'a submenu opens inside the sheet, with a way back');
await p.shot(join(shots, 'phone-submenu.png'));

// A triaged message's sheet: which tier and why, then the two marks, once.
await p.goto(`${hub}/#/inbox/c/${triaged.conversationId}?m=${triaged.id}`);
await p.until(`!!document.querySelector('#m-${triaged.id} .msg-body')`, 15000);
await Bun.sleep(600);
at = (await center(`#m-${triaged.id} .msg-body`))!;
await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
await Bun.sleep(650);
await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await Bun.sleep(400);
const foot = await p.eval<{ title: string; reasons: number; marks: string[]; actions: string[]; order: boolean }>(
  `(() => { const f = document.querySelector('.cm-sheet .sheet-triage'); const ul = f?.querySelector('ul'); const fb = f?.querySelector('.triage-fb'); return { title: f?.querySelector('h4')?.textContent ?? '', reasons: ul?.querySelectorAll('li').length ?? 0, marks: [...(f?.querySelectorAll('[data-mark]') ?? [])].map((b) => b.textContent.trim()), actions: [...document.querySelectorAll('.cm-sheet .sheet-action')].map((b) => b.textContent.trim()), order: !!ul && !!fb && !!(ul.compareDocumentPosition(fb) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`,
);
console.log('     phone sheet, triaged:', foot.title, '|', foot.marks.join(' | '));
check(foot.title.startsWith('Conversation:') && foot.reasons > 0 && foot.order && foot.marks.join() === 'Should have alerted,Less like this', 'a triaged message’s sheet says its tier and why, then has the two marks');
check(!foot.actions.includes('Should have alerted') && !foot.actions.includes('Less like this'), 'and its actions do not repeat them');
await p.shot(join(shots, 'phone-message-marks.png'));
await p.eval(`document.querySelector('.cm-sheet .sheet-triage [data-mark=alert]').click()`);
await Bun.sleep(600);
check((await p.eval<boolean>(`!document.querySelector('.cm-sheet')`)) && (await marksOf()).alert === true, 'tapping "Should have alerted" closes the sheet and marks it on the hub');

console.log(p.errors.length ? `page errors:\n${p.errors.join('\n')}` : 'no page errors');
await b.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
