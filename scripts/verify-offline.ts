/**
 * The hub out of reach (docs/sync.md "Quiet", ui/Offline.tsx) in headless Chromium, against a demo hub of its own that
 * it stops and starts again, tapped and clicked with real input events:
 *
 *   - a phone in a chat: the amber orb first of the header's buttons, the row over the box ends with "Offline · sends
 *     when the hub is back", and the top of the timeline says older messages wait for the hub, with no spinner;
 *   - a tap on the orb: since when, what the app shows, and Try now, which tries at once; Esc, a tap elsewhere and the
 *     orb again close it;
 *   - the phone's list and a computer: the rail's logo is the orb, slower than the loader and still under reduced
 *     motion; a click on it on a computer opens the same popover beside the rail and leaves the chat open;
 *   - each phone page over the rail (For you, Search, You, Requests, Directory, How it sorts): its own orb in its
 *     header, the only one on screen;
 *   - a send meanwhile waits on the device;
 *   - the hub back: everything as it was, at once, the top of the chat asking for older messages by itself, and the
 *     waiting send out, once.
 *
 *   bun scripts/verify-offline.ts [--shots <dir>]
 * Starts its own demo hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build. --shots
 * saves the four views (phone-chat, phone-pop, phone-list, desk-pop).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-offline-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};

/** The same hub each time: its port and its data dir, so the page comes back to it. */
async function startHub() {
  const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: REPO,
    env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 400; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return hub;
    await Bun.sleep(50);
  }
  throw new Error('the demo hub did not start');
}
const api = async <T = any>(path: string): Promise<T> => {
  const r = await fetch(url + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
};

let hub = await startHub();
const { page: p, close } = await launch();

/**
 * The first match on screen (with `onTop`, the first the page would hit at its middle): its box, and whether it is what
 * the page would hit there. An expression for the page.
 */
const AT = (sel: string, onTop = false) =>
  `(() => { const box = (x) => { const b = x.getBoundingClientRect(); if (!(b.width > 0 && b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight && x.checkVisibility({ visibilityProperty: true }))) return null; const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.left, top: b.top, right: b.right, bottom: b.bottom, own: !!h && (h === x || x.contains(h)) }; }; for (const e of document.querySelectorAll(${JSON.stringify(sel)})) { const r = box(e); if (r && (r.own || !${onTop})) return r; } return null; })()`;
const at = (sel: string) => p.eval<{ x: number; y: number; left: number; top: number; right: number; bottom: number; own: boolean } | null>(AT(sel));
const onScreen = (sel: string) => at(sel).then((r) => !!r);
const text = (sel: string) => p.eval<string | null>(`[...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0)?.textContent ?? null`);
/**
 * Where to press `sel`: once it is on screen, on top at its middle, and in the same place two frames later. A phone's
 * page still sliding (docs/phone.md) moves it between finding and pressing, and a press where it was lands elsewhere
 * (as in check-boot.ts).
 */
const target = async (sel: string) => {
  const twice = `(async () => { const one = ${AT(sel, true)}; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const two = ${AT(sel, true)}; return one && two && one.own && two.own && one.x === two.x && one.y === two.y ? two : null; })()`;
  await p.until(`${twice}.then((r) => !!(globalThis.__target = r))`, 5000).catch(() => {
    throw new Error(`nothing stays on screen, on top, that matches ${sel}`);
  });
  return p.eval<{ x: number; y: number }>('globalThis.__target');
};
const tap = async (sel: string) => {
  const r = await target(sel);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
};
const click = async (sel: string) => {
  const r = await target(sel);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const escape = async () => {
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
};
const shot = async (name: string) => shotsDir && (await p.shot(join(shotsDir, `${name}.png`)));
const orbTurn = (sel: string) => p.eval<{ name: string; duration: string; state: string } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const s = getComputedStyle(e); return { name: s.animationName, duration: s.animationDuration, state: s.animationPlayState }; })()`);
const POP_TEXT = /^Since .+\. Showing what this device kept; messages you send go out when it's back\.$/;
/** History's layer before the popover opened: on a phone the popover takes an entry of its own (phone.ts layers). */
let layerBefore: number | null = null;
const openPop = async (press: () => Promise<void>) => {
  layerBefore = await p.eval<number | null>('history.state?.layer ?? null');
  await press();
  await p.until(`!!document.querySelector('.offline-pop')`, 3000);
};
/**
 * The popover gone, and history back on the entry it was on before it opened: a phone's popover gives its entry back
 * a moment after it closes (phone.ts dropLayer), and a navigation made before that would be undone by it.
 */
const popClosed = () =>
  p.until(`!document.querySelector('.offline-pop') && (history.state?.layer ?? null) === ${layerBefore}`, 3000).catch(async () => {
    throw new Error(`the popover did not close and give back its history entry: ${await p.eval(`JSON.stringify({ open: !!document.querySelector('.offline-pop'), state: history.state, before: ${layerBefore}, focus: document.activeElement?.className ?? null })`)}`);
  });

try {
  // A direct conversation one of the demo accounts can send in.
  const boot = await api('/api/bootstrap');
  const sender = new Set(boot.accounts.filter((a: any) => a.status === 'online' && a.capabilities.includes('send')).map((a: any) => a.id));
  const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.lastMessage && c.vantages.some((v: any) => sender.has(v.accountId)));
  if (!conv) throw new Error('no direct conversation to send in');

  // ------------------------------------------------------------------ a phone in a chat, the hub there

  await p.size(412, 915, true);
  await p.goto(`${url}/#/inbox/c/${conv.id}`);
  // The service worker in charge, so the page starts again without the hub (sw.js).
  await p.until(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`, 30000);
  await p.goto(`${url}/#/inbox/c/${conv.id}`);
  await p.until(`!!navigator.serviceWorker.controller && document.querySelectorAll('.timeline-scroll .msg').length > 0 && !!document.querySelector('.conv-head-actions')`, 30000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.offline-orb, .typing-off, .older-wait')`)), 'with the hub there, no orb, no line over the box, nothing at the top');
  // What the device keeps to start from, written when the app goes out of sight (snapshot.ts).
  await p.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }), document.dispatchEvent(new Event('visibilitychange'))`);
  await p.until(
    `new Promise((res) => { const r = indexedDB.open('dither-chat'); r.onsuccess = () => { const d = r.result; if (!d.objectStoreNames.contains('snapshot')) { d.close(); return res(false); } const g = d.transaction('snapshot').objectStore('snapshot').get('last'); g.onsuccess = () => { d.close(); res(!!g.result); }; g.onerror = () => { d.close(); res(false); }; }; r.onerror = () => res(false); })`,
    20000,
  );

  // ------------------------------------------------------------------ the hub gone

  hub.kill('SIGKILL');
  await hub.exited;
  await p.until(`!!document.querySelector('.conv-head-actions .head-orb')`, 15000).then(
    () => check(true, 'the hub gone while the app is open: the orb comes'),
    () => check(false, 'the hub gone while the app is open: the orb comes'),
  );
  // And a start without it, from what the device kept: the chat's page waits for the hub.
  await p.eval(`window.beforeReload = true`);
  await p.send('Page.reload', {});
  await p.until(`!window.beforeReload && !!document.querySelector('.conv-head-actions .head-orb') && document.querySelectorAll('.timeline-scroll .msg').length > 0`, 20000);
  const head = await at('.conv-head-actions .head-orb');
  check(head?.own, 'a phone in a chat: the orb is in the header, on top where it is drawn', head);
  check(await p.eval<boolean>(`document.querySelector('.conv-head-actions').firstElementChild?.classList.contains('head-orb')`), '…first of its buttons');
  check((await p.eval<string>(`document.querySelector('.head-orb').getAttribute('aria-label')`)) === "Can't reach the hub", '…a button with a name');
  check((await text('.typing-bar .typing-off'))?.trim() === 'Offline · sends later', 'the row over the box ends with what happens to a send, short on a phone', await text('.typing-bar .typing-off'));
  check(await p.eval<boolean>(`(() => { const t = document.querySelector('.typing-bar .typing-off'), m = t.querySelector('.typing-off-more'); return m.getBoundingClientRect().top < t.getBoundingClientRect().bottom - 2; })()`), '…all of it shown beside the route');
  check(await onScreen('.typing-bar .typing-off .offline-orb'), '…after a small orb');
  check(!(await onScreen('.typing-bar .pair-last')), "…and the last message's route gives way");
  check((await p.eval<string | null>(`document.querySelector('.timeline-scroll .older-wait')?.textContent ?? null`)) === 'Older messages load when the hub is back', 'the top of the timeline says older messages wait for the hub');
  check(!(await p.eval<boolean>(`!!document.querySelector('.timeline-scroll .loading')`)), '…with no spinner');
  check(!(await p.eval<boolean>(`!!document.querySelector('.reconnect')`)), 'no pill over the header');
  await shot('phone-chat');

  // ------------------------------------------------------------------ the popover

  await openPop(() => tap('.conv-head-actions .head-orb'));
  const pop = await at('.offline-pop');
  check((await text('.offline-pop b')) === "Can't reach the hub", 'a tap on the orb opens the popover');
  check(POP_TEXT.test((await text('.offline-pop p')) ?? ''), '…since when, and what the app shows meanwhile', await text('.offline-pop p'));
  check(pop && head && pop.top >= head.bottom && pop.left >= 0 && pop.right <= 412 && pop.own, '…under the orb, on the screen, on top', { pop, head });
  check((await p.eval<string>(`document.activeElement?.textContent ?? ''`)) === 'Try now', '…with Try now focused');
  await shot('phone-pop');
  await escape();
  await popClosed();
  check(await p.eval<boolean>(`document.activeElement?.classList.contains('head-orb')`), 'Esc closes it, back on the orb');
  await openPop(() => tap('.conv-head-actions .head-orb'));
  // A day's line in the timeline: somewhere a tap does nothing else.
  await tap('.timeline-scroll .day-sep');
  await popClosed();
  check(true, 'a tap elsewhere closes it');
  await openPop(() => tap('.conv-head-actions .head-orb'));
  await tap('.conv-head-actions .head-orb');
  await popClosed();
  check(true, 'the orb again closes it');

  // Try now with the hub still gone: a try at once, which says it got no answer.
  await openPop(() => tap('.conv-head-actions .head-orb'));
  await tap('.offline-pop .btn');
  await p.until(`document.querySelector('.offline-pop-missed')?.textContent === 'No answer yet' && document.querySelector('.offline-pop .btn')?.textContent === 'Try now'`, 10000).then(
    () => check(true, 'Try now tries at once, and says when the hub did not answer'),
    async () => check(false, 'Try now tries at once, and says when the hub did not answer', await text('.offline-pop')),
  );
  await escape();
  await popClosed();

  // ------------------------------------------------------------------ the phone's list: the rail's logo

  await p.eval(`location.hash = '#/inbox'`);
  // Once the chat's card has left the screen (ui/Pager.ts: off its open rest, and its slide's transition over), the rail's
  // orb is what a tap there would hit.
  await p.until(`(() => { const app = document.querySelector('.app'), card = document.querySelector('.app > .center'); return !!app && !!card && !app.classList.contains('rest-open') && card.getAnimations().length === 0; })()`, 5000);
  await p.until(`(() => { const e = document.querySelector('.rail .rail-btn:has(.offline-orb)'); if (!e) return false; const b = e.getBoundingClientRect(); const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!h && e.contains(h); })()`, 5000).then(
    () => check(true, "the phone's list: the rail's logo is the orb, on top where it is drawn"),
    async () => check(false, "the phone's list: the rail's logo is the orb, on top where it is drawn", await at('.rail .rail-btn:has(.offline-orb)')),
  );
  check(/Can't reach the hub/.test(await p.eval<string>(`document.querySelector('.rail .rail-btn:has(.offline-orb)').getAttribute('aria-label')`)), "…its button's name says so");
  check(!(await onScreen('.head-orb')), '…and no second orb on the screen');
  const turning = await orbTurn('.rail .offline-orb .orb-turn');
  check(turning?.duration === '5.04s' && turning.state === 'running', '…turning, slower than the loader (140 ms a frame)', turning);
  await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check((await orbTurn('.rail .offline-orb .orb-turn'))?.name === 'none', '…and still under reduced motion');
  await p.send('Emulation.setEmulatedMedia', { features: [] });
  await shot('phone-list');

  // Each phone page that covers the rail: an orb of its own in its header, the only one on screen, on top. (The page's
  // orb is told from the last page's by a mark set before leaving it.)
  const onTopOrbs = `[...document.querySelectorAll('.offline-orb')].filter((e) => { const b = e.getBoundingClientRect(); if (!(b.width > 0 && b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight)) return false; const btn = e.closest('button'), h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !!btn && !!h && btn.contains(h); })`;
  for (const [hash, name] of [
    ['#/foryou', 'For you'],
    ['#/search?q=', 'Search'],
    ['#/settings', 'You'],
    ['#/requests', 'Requests'],
    ['#/directory', 'Directory'],
    ['#/model', 'How it sorts'],
  ]) {
    await p.eval(`document.querySelectorAll('.head-orb').forEach((e) => (e.dataset.left = '1')), (location.hash = ${JSON.stringify(hash)})`);
    await p.until(`(() => { const on = ${onTopOrbs}; return document.querySelector('.app').classList.contains('rest-open') && document.querySelector('.app > .center').getAnimations().length === 0 && on.length === 1 && !!on[0].closest('.head-orb:not([data-left])'); })()`, 5000).then(
      () => check(true, `a phone's ${name}: its own orb in the header, the only one on screen`),
      async () => check(false, `a phone's ${name}: its own orb in the header, the only one on screen`, await p.eval(`${onTopOrbs}.map((e) => e.closest('button').className)`)),
    );
    // On the header's first row, not wrapped onto a row of its own under the title.
    const row = await p.eval<number>(`(() => { const o = document.querySelector('.head-orb:not([data-left])'); return o.getBoundingClientRect().top - o.closest('header').getBoundingClientRect().top; })()`);
    check(row < 30, `…on the header's first row`, { fromHeaderTop: row });
  }

  await p.eval(`location.hash = '#/inbox/c/${conv.id}'`);
  await p.until(`!!document.querySelector('.conv-head-actions .head-orb')`, 5000);
  check((await orbTurn('.rail .offline-orb .orb-turn'))?.state === 'paused', "under a phone's page the rail's orb stands still");

  // ------------------------------------------------------------------ a computer

  await p.size(1280, 800, false);
  await p.until(`!!document.querySelector('.titlebar') && !!document.querySelector('.rail .rail-logo .offline-orb')`, 5000);
  check(!(await onScreen('.head-orb')), "a computer: the rail's orb only, none in the header");
  check((await text('.typing-bar .typing-off'))?.trim() === 'Offline · sends when the hub is back', 'a computer: the row over the box says it in full', await text('.typing-bar .typing-off'));
  // Away from the inbox, the logo's button still goes there, with no popover.
  await p.eval(`location.hash = '#/foryou'`);
  await p.until(`location.hash.startsWith('#/foryou') && !!document.querySelector('.rail .rail-btn:has(.offline-orb)')`, 5000);
  await click('.rail .rail-btn:has(.offline-orb)');
  await p.until(`location.hash.startsWith('#/inbox')`, 5000).then(
    async () => check(!(await p.eval<boolean>(`!!document.querySelector('.offline-pop')`)), "a computer away from the inbox: the logo's button goes to the inbox, no popover"),
    async () => check(false, "a computer away from the inbox: the logo's button goes to the inbox, no popover", await p.eval('location.hash')),
  );
  await p.eval(`location.hash = '#/inbox/c/${conv.id}'`);
  await p.until(`location.hash.includes(${JSON.stringify(conv.id)}) && document.querySelectorAll('.timeline-scroll .msg').length > 0`, 5000);
  await openPop(() => click('.rail .rail-btn:has(.offline-orb)'));
  const deskPop = await at('.offline-pop');
  const rail = await at('.rail .rail-btn:has(.offline-orb)');
  check(deskPop && rail && deskPop.left >= rail.right && deskPop.own, 'a click on it opens the popover beside the rail', { deskPop, rail });
  check((await p.eval<string>('location.hash')).includes(conv.id), '…and leaves the chat open');
  check(POP_TEXT.test((await text('.offline-pop p')) ?? ''), '…saying the same');
  await shot('desk-pop');
  await escape();
  await popClosed();
  check(true, '…and Esc closes it');
  // Even an Esc the moment it is in the page, before anything is painted (an observer of the page presses it): the
  // popover listens from when it is drawn.
  layerBefore = await p.eval<number | null>('history.state?.layer ?? null');
  const quickEsc = await p.eval<boolean>(
    `new Promise((done) => { const mo = new MutationObserver(() => { if (!document.querySelector('.offline-pop')) return; mo.disconnect(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); requestAnimationFrame(() => requestAnimationFrame(() => done(!document.querySelector('.offline-pop')))); }); mo.observe(document.body, { childList: true }); document.querySelector('.rail .rail-btn:has(.offline-orb)').click(); })`,
  );
  check(quickEsc, '…even an Esc pressed the moment it is drawn');
  if (!quickEsc) await escape();
  await popClosed();

  // ------------------------------------------------------------------ a send meanwhile

  const queued = `sent without the hub ${Date.now().toString(36)}`;
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await p.send('Input.insertText', { text: queued });
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
  await p.until(`[...document.querySelectorAll('.msg.pending.queued')].some((e) => e.textContent.includes(${JSON.stringify(queued)}))`, 6000).then(
    () => check(true, 'a send meanwhile waits on the device'),
    async () => check(false, 'a send meanwhile waits on the device', await p.eval(`({ pending: [...document.querySelectorAll('.msg.pending')].map((e) => e.className + ': ' + e.textContent), box: document.querySelector('.composer textarea')?.value })`)),
  );

  // The top of the chat, where what the device does not have waits for the hub (scrolled up until it is in view).
  await p.until(`(() => { const s = document.querySelector('.timeline-scroll'); s.scrollTop = -s.scrollHeight; return ${AT('.timeline-scroll .older-wait')} !== null; })()`, 5000).then(
    () => check(true, 'a computer, at the top of the chat: older messages wait for the hub'),
    () => check(false, 'a computer, at the top of the chat: older messages wait for the hub'),
  );
  const topBefore = await p.eval<string>(`[...document.querySelectorAll('.timeline-scroll .msg[id^="m-"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]?.id`);

  // ------------------------------------------------------------------ the hub back

  await openPop(() => click('.rail .rail-btn:has(.offline-orb)'));
  hub = await startHub();
  // Try now, unless the app's own retry got there first (then there is no popover to try from): looked for and pressed
  // in one go in the page, so the retry cannot land in between.
  await p.eval(`document.querySelector('.offline-pop .btn')?.click()`);
  await p.until(`!document.querySelector('.offline-orb, .offline-pop, .typing-off, .older-wait, .head-orb')`, 20000).then(
    () => check(true, 'the hub back: the orb, the popover, the line and the wait all go'),
    async () => check(false, 'the hub back: the orb, the popover, the line and the wait all go', await p.eval(`[...document.querySelectorAll('.offline-orb, .offline-pop, .typing-off, .older-wait, .head-orb')].map((e) => e.className)`)),
  );
  // The top of the chat asks the hub by itself, and says what it answered: older messages drawn above what was the top,
  // or the line that this is where the hub's messages start (the demo's chats are short).
  await p.until(`(() => { if (document.querySelector('.timeline-scroll .timeline-start')) return true; const old = document.getElementById(${JSON.stringify(topBefore)}); if (!old) return false; const t = old.getBoundingClientRect().top; return [...document.querySelectorAll('.timeline-scroll .msg[id^="m-"]')].some((e) => e.getBoundingClientRect().top < t); })()`, 15000).then(
    () => check(true, '…and the top of the chat asks the hub by itself: older messages, or where they start'),
    async () => check(false, '…and the top of the chat asks the hub by itself: older messages, or where they start', await p.eval(`document.querySelector('.timeline-scroll')?.firstElementChild?.className ?? null`)),
  );
  check(await p.eval<boolean>(`!!document.querySelector('.rail .rail-logo > svg')`), "…the rail's logo is the logo again");
  await p.until(`!document.querySelector('.msg.pending') && [...document.querySelectorAll('.timeline-scroll .msg-body')].some((e) => e.textContent.includes(${JSON.stringify(queued)}))`, 15000).then(
    () => check(true, '…and the send that waited went out'),
    () => check(false, '…and the send that waited went out'),
  );
  const sent = await api(`/api/conversations/${conv.id}/messages?limit=60`).then((r: any) => r.messages.filter((m: any) => m.body === queued).length);
  check(sent === 1, '…once', sent);

  const errors = p.errors.filter((e) => !/ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|WebSocket connection|Failed to (load resource|fetch)/.test(e));
  check(!errors.length, 'no script errors', errors);
} catch (e) {
  check(false, 'ran to the end', String(e));
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
