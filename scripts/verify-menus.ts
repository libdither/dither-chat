/**
 * Right-click menus and forwarding, end to end against a demo hub, in headless Chromium: desktop menus by
 * mouse and keyboard, Shift+right-click left alone, the menu kept inside the window, a triaged message's two marks
 * ("Louder", "Quieter") as ticked entries, a channel's notification rule (Automatic, Always
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
}
async function click(x: number, y: number) {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'left');
  await mouse('mouseReleased', x, y, 'left');
}
async function key(k: string, code = k) {
  const text = k.length === 1 ? k : undefined;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, ArrowLeft: 37, Escape: 27, Enter: 13 }[k] ?? k.toUpperCase().charCodeAt(0) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
}
// Each check waits for the page or the hub to show what it checks, never a fixed time: on a busy machine a click can
// take seconds to be drawn (docs/testing.md, "No sleeps"). The bound only ends a run whose page never gets there.
/** Waits until `expr` holds in the page; says whether it did. */
const holds = (expr: string, ms = 15000) => p.until(expr, ms).then(
  () => true,
  () => false,
);
/** Waits until the hub's answer is what `ok` wants; returns the last answer. */
async function hubHolds<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > end) return v;
    await Bun.sleep(100);
  }
}
/** Two frames: what the input before set off has been handled and drawn. */
const drawn = () => p.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
/** Waits until the element stops moving (a jump to a message scrolls it there), so a click lands on it. */
const still = (sel: string) =>
  p.eval(`(async () => { const f = () => new Promise((r) => requestAnimationFrame(r)); let last = ''; for (let i = 0, same = 0; i < 300 && same < 3; i++) { await f(); const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); const now = r ? r.top + ',' + r.left : ''; same = now === last ? same + 1 : 0; last = now; } })()`);
/**
 * Another page, once what was open has closed: a menu or sheet is a layer with a history entry of its own, and closing
 * it steps back off that entry a moment later (phone.ts pushLayer). Navigating before that step lands crosses it: the
 * address says the new page and the app stays on the old one.
 */
async function go(url: string) {
  await holds(`!document.querySelector('.cm, .cm-sheet') && !history.state?.layer`);
  await p.goto(url);
}
/** A long press: held until the sheet opens (the app opens it while the finger is down), then lifted. */
async function longPress(x: number, y: number) {
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await holds(`!!document.querySelector('.cm-sheet')`);
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
/** The middle of `sel`, scrolled into view, with no toast over it (one says a forward went, and would take the press). */
async function center(sel: string) {
  const at = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) return null;
  const covered = `!!document.elementFromPoint(${at.x}, ${at.y})?.closest('.toasts')`;
  if (await p.eval<boolean>(covered)) {
    await p.eval(`document.querySelectorAll('.toasts .toast-x').forEach((x) => x.click())`);
    await holds(`!${covered}`);
  }
  return at;
}
const labels = (sel = '.cm:last-of-type') => p.eval<string[]>(`[...document.querySelectorAll('${sel} .cm-item, ${sel} .cm-sep, ${sel} .cm-row')].map((e) => e.classList.contains('cm-sep') ? '—' : e.classList.contains('cm-row') ? '[quick reactions]' : e.querySelector('.cm-text').textContent + (e.classList.contains('danger') ? ' (red)' : '') + (e.querySelector('.cm-hint') ? ' [' + e.querySelector('.cm-hint').textContent + ']' : ''))`);
const menuOpen = () => p.eval<number>(`document.querySelectorAll('.cm').length`);
/** `within`: only items under this selector (a submenu), where the menu above it has one that starts the same. */
const clickItem = async (label: string, within = '') => {
  await still(within ? `${within} .cm-item` : '.cm .cm-item, .cm-sheet .sheet-action');
  const at = await p.eval<{ x: number; y: number } | null>(`(() => { const e = [...document.querySelectorAll('${within} .cm-item, ${within} .sheet-action')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!at) throw new Error(`no item ${label}`);
  await click(at.x, at.y);
};

/**
 * Opens a conversation and waits until it has switched (its `dither:timeline` mark, docs/perf.md): its newest message
 * on screen or the hub's answer in. Before that the timeline may still re-anchor to its newest end, and a menu closes
 * on any scroll, so a right-click on what it first drew can lose its menu.
 */
async function openConv(path: string, convId: string, ms = 15000) {
  const t0 = Date.now() - 1;
  await go(`${hub}/#${path}`);
  await p.until(`(() => { const m = performance.getEntriesByName('dither:timeline')[0]; return !!m && m.detail?.key === 'c:${convId}' && performance.timeOrigin + m.startTime >= ${t0}; })()`, ms);
  await p.until(`document.querySelectorAll('.msg:not(.system) .msg-body').length > 2`, ms);
}

// ------------------------------------------------------------------ desktop
await p.size(1280, 800);
await openConv(`/s/${dither.id}/c/${general.id}`, general.id);
// Opening a chat ends with the caret in its box (ui/Timeline.tsx). On a busy machine that can come after a quick
// right-click and take the keys from the menu, so the keyboard checks below wait for it first.
await holds(`document.activeElement?.matches('.composer textarea') === true`);
const msgSel = `.msg:not(.system):not(.pending) .msg-body`;
await still(msgSel);
let at = (await center(msgSel))!;
await rightClick(at.x, at.y);
check((await holds(`document.querySelectorAll('.cm').length === 1 && !!document.querySelector('.cm .cm-row')`)) && (await menuOpen()) === 1, 'right-click on a message opens one menu');
const msgItems = await labels();
console.log('     message menu:', msgItems.join(' | '));
check(msgItems.includes('Forward [F]') && msgItems.includes('Copy Message ID') && msgItems.includes('[quick reactions]'), 'the message menu has reactions, Forward and the ID');
await p.shot(join(shots, 'desktop-message-menu.png'));

// keyboard: down to Add Reaction, right opens its submenu, left closes it, escape closes the menu
await key('ArrowDown');
const activeIs = (t: string) => holds(`document.querySelector('.cm-item.active .cm-text')?.textContent === ${JSON.stringify(t)}`);
check(await activeIs('Add Reaction'), 'ArrowDown reaches the first item');
await key('ArrowRight');
check(await holds(`document.querySelectorAll('.cm').length === 2`), 'ArrowRight opens the submenu');
await key('ArrowLeft');
check(await holds(`document.querySelectorAll('.cm').length === 1`), 'ArrowLeft closes only the submenu');
await key('ArrowUp');
check(await activeIs('Copy dither-chat ID'), 'ArrowUp wraps to the last item');
await key('Escape');
check(await holds(`document.querySelectorAll('.cm').length === 0`), 'Escape closes the menu');

// Shift+right-click is the browser's: once the page has had the event and drawn what it set off, no menu of ours.
await p.eval(`window.__menus = 0; document.addEventListener('contextmenu', () => window.__menus++, { capture: true })`);
await rightClick(at.x, at.y, 8);
await holds(`window.__menus > 0`);
await drawn();
check((await menuOpen()) === 0, 'Shift+right-click opens no menu of ours');

// kept inside the window
// The last message in view first: the right-click above scrolled the first to the centre, and when the timeline's
// first slice has drawn many messages by then (docs/perf.md, "First opens draw in slices") the last is below the window.
// A menu closes on any scroll, so the right-click waits until that scroll has landed and the message stands still.
await p.eval(`(() => { const ms = [...document.querySelectorAll('.msg:not(.system):not(.pending)')]; ms[ms.length - 1].dataset.corner = '1'; ms[ms.length - 1].scrollIntoView({ block: 'end' }); })()`);
await still('[data-corner]');
const corner = await p.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-corner]').getBoundingClientRect(); return { x: Math.min(innerWidth - 4, r.right - 4), y: r.bottom - 4 }; })()`);
await rightClick(corner.x, corner.y);
await holds(`!!document.querySelector('.cm')`);
const box = await p.eval<{ l: number; t: number; r: number; b: number } | null>(`(() => { const r = document.querySelector('.cm')?.getBoundingClientRect(); return r && { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
check(box && box.r <= 1280 && box.b <= 800 && box.l >= 0 && box.t >= 0, `a menu opened in the corner stays inside the window (${JSON.stringify(box)})`);
await click(400, 300);
check(await holds(`document.querySelectorAll('.cm').length === 0`), 'a click outside closes it');

// a channel in the sidebar, with the notification submenu by hover
at = (await center('.chan.active'))!;
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
const chanItems = await labels();
console.log('     channel menu:', chanItems.join(' | '));
check(chanItems[0].startsWith('Mark As Read') && chanItems.some((l) => l.startsWith('Notification Settings')) && chanItems.includes('Copy Channel ID'), 'the channel menu');
await still('.cm .cm-item');
const notif = await p.eval<{ x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.cm-item')].find((b) => b.textContent.startsWith('Notification Settings')); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
await mouse('mouseMoved', notif.x, notif.y);
check(await holds(`document.querySelectorAll('.cm').length === 2 && !!document.querySelector('.cm-sub .cm-item')`), 'hovering Notification Settings opens its submenu');
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
check((await hubHolds(ruleOf, (r) => r === 'digest')) === 'digest', 'choosing List only sets the rule on the hub');
// The rule reaches the page over the socket; the menu opened after that shows it.
await holds(`document.querySelectorAll('.cm').length === 0`);
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
await mouse('mouseMoved', notif.x, notif.y);
await holds(`[...document.querySelectorAll('.cm-sub .cm-item[aria-checked=true]')].some((e) => e.textContent.includes('List only'))`);
now = await chosen();
check(now.on.join() === 'List only' && now.note === '', `the submenu then has List only chosen, and no line under Automatic (${JSON.stringify(now)})`);
await clickItem('Mute', '.cm-sub');
check((await hubHolds(ruleOf, (r) => r === 'none')) === 'none', 'choosing Mute sets the rule on the hub');
await holds(`document.querySelectorAll('.cm').length === 0`);
await rightClick(at.x, at.y);
check(await holds(`[...document.querySelectorAll('.cm .cm-item .cm-text')].some((e) => e.textContent === 'Unmute Channel')`), 'a muted channel offers Unmute');
await clickItem('Unmute Channel');
check((await hubHolds(ruleOf, (r) => r === null)) === null, 'Unmute takes the rule away: Automatic again');

// a triaged message from someone else: the two marks, ticked entries in a group of their own
const triaged = ((await fetch(`${hub}/api/inbox`).then((r) => r.json())) as any).items.map((i: any) => i.message).find((m: any) => m.triage?.decision === 'quiet' && !m.triage.marks);
const marksOf = async () => ((await fetch(`${hub}/api/inbox`).then((r) => r.json())) as any).items.find((i: any) => i.message.id === triaged.id)?.message.triage.marks ?? {};
await go(`${hub}/#/inbox/c/${triaged.conversationId}?m=${triaged.id}`);
await p.until(`!!document.querySelector('#m-${triaged.id} .msg-body')`, 15000);
await still(`#m-${triaged.id} .msg-body`);
// A mark is an answer to the hub (loudness.ts answer()); its reply may open "Why quieter?". Counted, to wait for it.
await p.eval(`(() => {
  const f = window.fetch;
  window.__answers = 0;
  window.fetch = function (u, ...a) {
    const r = f.call(this, u, ...a);
    return String(u instanceof Request ? u.url : u).includes('/api/loudness/answers') ? r.finally(() => window.__answers++) : r;
  };
})()`);
const markAt = (await center(`#m-${triaged.id} .msg-body`))!;
/** The marks in the open menu: each entry's words and whether it is ticked. */
// (Reply marks, "No reply needed" and "Reply needed", are a group of their own before them: verify-reply-marks.ts.)
const marksShown = () => p.eval<string[]>(`[...document.querySelectorAll('.cm .cm-item[role=menuitemcheckbox]')].map((e) => e.querySelector('.cm-text').textContent + (e.getAttribute('aria-checked') === 'true' ? ' ✓' : '')).filter((t) => !/^(No reply needed|Reply needed)/.test(t))`);
await rightClick(markAt.x, markAt.y);
await holds(`[...document.querySelectorAll('.cm .cm-item .cm-text')].some((e) => e.textContent === 'Louder')`);
const withMarks = await labels();
console.log('     triaged message menu:', withMarks.join(' | '));
const mi = withMarks.indexOf('Louder');
check(mi > 0 && withMarks[mi - 1] === '—' && withMarks[mi + 1] === 'Quieter' && withMarks[mi + 2] === '—', 'a triaged message has "Louder" and "Quieter" in a group of their own');
check((await marksShown()).join() === 'Louder,Quieter', 'neither is ticked at first');
check(!withMarks.some((l) => /Important|Active|Digest|Not interesting|Should have alerted|Less like this/.test(l)), 'and no level or old mark to pick');
await p.shot(join(shots, 'desktop-message-marks.png'));
/** The open menu's marks are these: the page has the mark the hub keeps. */
const marksAre = (want: string) =>
  holds(`[...document.querySelectorAll('.cm .cm-item[role=menuitemcheckbox]')].map((e) => e.querySelector('.cm-text').textContent + (e.getAttribute('aria-checked') === 'true' ? ' ✓' : '')).filter((t) => !/^(No reply needed|Reply needed)/.test(t)).join() === ${JSON.stringify(want)}`);
/** Once the `n`th mark's answer is back and drawn, "Skip" on the "Why?" it may open, so the next right-click reaches the message. */
const skipFollow = async (n: number) => {
  await holds(`window.__answers >= ${n}`);
  await drawn();
  await p.eval(`document.querySelector('.loud-follow-body') && [...document.querySelectorAll('.loud-actions .btn')].find((b) => b.textContent.includes('Skip'))?.click()`);
  await holds(`!document.querySelector('.loud-follow-body')`);
};
await clickItem('Quieter');
// Quieter on a Conversation stands as "Less like this" (docs/notifications.md, "Marks").
const closed = await holds(`document.querySelectorAll('.cm').length === 0`);
check(closed && (await hubHolds(marksOf, (m: any) => m.less === true)).less === true, 'choosing "Quieter" closes the menu and stands as "Less like this" on the hub');
await skipFollow(1);
await rightClick(markAt.x, markAt.y);
check(await marksAre('Louder,Quieter ✓'), 'the menu then shows it ticked');
await clickItem('Louder');
check((await hubHolds(marksOf, (m: any) => m.alert === true)).alert === true, '"Louder" stands as "Should have alerted" on the hub');
await holds(`document.querySelectorAll('.cm').length === 0`);
await skipFollow(2);
await rightClick(markAt.x, markAt.y);
check(await marksAre('Louder ✓,Quieter'), 'and shows ticked');
await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await openConv(`/s/${dither.id}/c/${general.id}`, general.id);

// the server in the rail, the accounts button
at = (await center(`.rail-item[data-dnd-key^="space:"] .rail-btn`))!;
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
const spaceItems = await labels();
console.log('     server menu:', spaceItems.join(' | '));
check(spaceItems.some((l) => /^Mute (Server|Space)$/.test(l)) && spaceItems.some((l) => /^Copy (Server|Space) ID$/.test(l)), 'the server menu');
await key('Escape');
await holds(`document.querySelectorAll('.cm').length === 0`);
at = (await center(`.rail-foot .rail-btn[aria-label="Accounts and connections"]`))!;
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
const accItems = await labels();
console.log('     accounts menu:', accItems.join(' | '));
check(accItems.some((l) => l.startsWith('Discord · main')), 'the accounts menu lists accounts');
await key('Escape');
await holds(`document.querySelectorAll('.cm').length === 0`);

// a person
at = (await center(`.msg:not(.system) .msg-author`))!;
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
const personItems = await labels();
console.log('     person menu:', personItems.join(' | '));
check(personItems[0] === 'Profile' && personItems.includes('Copy') && !personItems.some((l) => /^(Star|Unstar|Copy from)/.test(l)), 'the person menu: one Copy entry, no star');
await key('Escape');
await holds(`document.querySelectorAll('.cm').length === 0`);

// ------------------------------------------------------------------ forwarding
// The demo seeds a forward in #dev: Lev forwarded the announcement.
await go(`${hub}/#/s/${dither.id}/c/${dev.id}`);
await p.until(`document.querySelector('.fwd-card') !== null`, 10000);
check(await p.eval(`document.querySelector('.fwd-card .fwd-card-src')?.textContent.includes('announcements')`), 'an incoming Discord forward shows as a card with where it came from');
await p.shot(join(shots, 'desktop-incoming-forward.png'));

// Forward a message from #general to #dev (native, demo) and to Housemates on Matrix (cross-network).
await openConv(`/s/${dither.id}/c/${general.id}`, general.id, 10000);
await still(msgSel);
at = (await center(msgSel))!;
const original = await p.eval<string>(`document.querySelector(${JSON.stringify(msgSel)}).textContent`);
await rightClick(at.x, at.y);
await holds(`!!document.querySelector('.cm .cm-item')`);
await key('f');
check(await holds(`document.querySelector('.fwd') !== null`), 'F in the menu opens the forward dialog');
const pick = async (q: string) => {
  const row = `[...document.querySelectorAll('.fwd-row:not(:disabled)')].find((r) => r.querySelector('b').textContent.replace(/^#/, '') === ${JSON.stringify(q)})`;
  await p.eval(`(() => { const i = document.querySelector('.fwd-search input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  if (!(await holds(`!!${row}`))) throw new Error(`no destination named ${q}`);
  await p.eval(`${row}.click()`);
  await holds(`[...document.querySelectorAll('.fwd-row.on b')].some((b) => b.textContent.replace(/^#/, '') === ${JSON.stringify(q)})`);
};
await pick('dev');
await pick('Nix Development');
await p.eval(`(() => { const i = document.querySelector('.fwd-note'); i.value = 'forward test note'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await p.eval(`(() => { const i = document.querySelector('.fwd-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await holds(`document.querySelectorAll('.fwd-row.on .fwd-how').length === 2`);
const hows = await p.eval<string[]>(`[...document.querySelectorAll('.fwd-row.on .fwd-how')].map((e) => e.textContent)`);
check(hows.sort().join() === 'Copy to Matrix,Forward', `the dialog says how each will go (${hows.join(', ')})`);
await p.shot(join(shots, 'desktop-forward-dialog.png'));
await p.eval(`document.querySelector('.fwd-send .btn.primary').click()`);
await p.until(`document.querySelector('.fwd') === null`, 8000);
check(true, 'sending closes the dialog');

await openConv(`/s/${dither.id}/c/${dev.id}`, dev.id);
await p.until(`[...document.querySelectorAll('.fwd-card')].some((c) => c.textContent.includes(${JSON.stringify(original.slice(0, 20))}))`, 8000);
check(await p.eval(`[...document.querySelectorAll('.msg-body')].some((b) => b.textContent === 'forward test note')`), 'the native forward arrives with its note after it');
await p.shot(join(shots, 'desktop-native-forward.png'));

await openConv(`/inbox/c/${nixdev.id}`, nixdev.id);
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
await openConv(`/s/${dither.id}/c/${general.id}`, general.id, 10000);
await still(msgSel);
at = (await center(msgSel))!;
await longPress(at.x, at.y);
await holds(`!!document.querySelector('.cm-sheet .sheet-action')`);
const sheet = await p.eval<string[]>(`[...document.querySelectorAll('.cm-sheet .sheet-action')].map((b) => b.textContent.trim())`);
console.log('     phone sheet:', sheet.join(' | '));
check(sheet.includes('Forward') && (await p.eval(`!!document.querySelector('.cm-sheet .msg-sheet-head') && !!document.querySelector('.cm-sheet .sheet-quick')`)), 'a long press opens the same menu as a sheet, with the message and quick reactions on top');
await p.shot(join(shots, 'phone-message-sheet.png'));
await p.eval(`[...document.querySelectorAll('.cm-sheet .sheet-action')].find((b) => b.textContent.trim() === 'Add Reaction').click()`);
check(await holds(`!!document.querySelector('.cm-sheet-back')`), 'a submenu opens inside the sheet, with a way back');
await p.shot(join(shots, 'phone-submenu.png'));

// A triaged message's sheet: which tier and why, then the two marks, once.
await go(`${hub}/#/inbox/c/${triaged.conversationId}?m=${triaged.id}`);
await p.until(`!!document.querySelector('#m-${triaged.id} .msg-body')`, 15000);
await still(`#m-${triaged.id} .msg-body`);
at = (await center(`#m-${triaged.id} .msg-body`))!;
await longPress(at.x, at.y);
await holds(`!!document.querySelector('.cm-sheet .sheet-triage [data-mark]')`);
const foot = await p.eval<{ title: string; reasons: number; marks: string[]; actions: string[]; order: boolean }>(
  `(() => { const f = document.querySelector('.cm-sheet .sheet-triage'); const ul = f?.querySelector('ul'); const fb = f?.querySelector('.triage-fb'); return { title: f?.querySelector('h4')?.textContent ?? '', reasons: ul?.querySelectorAll('li').length ?? 0, marks: [...(f?.querySelectorAll('[data-mark]') ?? [])].map((b) => b.textContent.trim()), actions: [...document.querySelectorAll('.cm-sheet .sheet-action')].map((b) => b.textContent.trim()), order: !!ul && !!fb && !!(ul.compareDocumentPosition(fb) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`,
);
console.log('     phone sheet, triaged:', foot.title, '|', foot.marks.join(' | '));
check(foot.title.startsWith('Conversation:') && foot.reasons > 0 && foot.order && foot.marks.join() === 'Louder,Quieter', 'a triaged message’s sheet says its tier and why, then has Louder and Quieter');
check(!foot.actions.includes('Louder') && !foot.actions.includes('Quieter'), 'and its actions do not repeat them');
await p.shot(join(shots, 'phone-message-marks.png'));
await p.eval(`document.querySelector('.cm-sheet .sheet-triage [data-mark=louder]').click()`);
check((await holds(`!document.querySelector('.cm-sheet')`)) && (await hubHolds(marksOf, (m: any) => m.alert === true)).alert === true, 'tapping "Louder" closes the sheet and stands as "Should have alerted" on the hub');

console.log(p.errors.length ? `page errors:\n${p.errors.join('\n')}` : 'no page errors');
await b.close();
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
