/**
 * Adversarial features (docs/history.md) and the composer taking focus, end to end against a demo hub in headless
 * Chromium: by default nothing deleted or disappeared is kept and the switches are out of sight; Message history says
 * so, with no Forget for what has nothing kept; the warning's "Yes" stays greyed for 15 seconds; ticking it shows the
 * switches, each off and saying where it shows, with a line saying so; turning on Deleted keeps what is deleted and
 * Message history stops saying nothing is kept; hiding them turns them off again. Server members (passive) are
 * recorded only once their switch is on, and a server's About then says how many were seen. Opening a chat from the
 * sidebar puts the cursor in its message box. At phone size: Sections in Settings' header reaches the section in two
 * taps, the warning's Yes is on screen without scrolling, the switches are in view after it, and rows are 44px.
 *
 *   bun scripts/verify-adversarial.ts http://127.0.0.1:8499 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo, without --adversarial) with its own data dir: this changes settings.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8499';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const climb = boot.conversations.find((c: any) => c.name === 'Climbing crew 🧗')?.id;
if (!climb) throw new Error('the demo world lacks Climbing crew');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const retention = () => fetch(`${hub}/api/retention`).then((r) => r.json()) as Promise<any>;
const libdither = boot.spaces.find((s: any) => s.name === 'libdither' && s.kind === 'community')?.id;
if (!libdither) throw new Error('the demo world lacks libdither');
const coverage = () => fetch(`${hub}/api/spaces/${libdither}/about`).then((r) => r.json()).then((a: any) => a.coverage) as Promise<any>;

const { page: p, close } = await launch();
await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
async function click(selector: string) {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
/** A finger on the first match, where it is now: no scrolling first, as a person sees it. */
async function tap(selector: string, pick = 'el => true') {
  const r = await p.eval<[number, number] | null>(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(${pick}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
  await touch('touchStart', [r]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
  await Bun.sleep(400);
}
/** Whether all of the first match is on screen: below Settings' header and above the tab bar, or in the window for a dialog. */
const inView = (selector: string) =>
  p.eval<boolean>(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return false;
    const r = e.getBoundingClientRect();
    const head = e.closest('.settings') && !e.closest('.board-head') ? document.querySelector('.settings .board-head').getBoundingClientRect().bottom : 0;
    const bar = e.closest('.modal, .sheet') ? null : document.querySelector('.app.tabs > .tabbar');
    const foot = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top : innerHeight;
    return r.height > 0 && r.top >= head - 1 && r.bottom <= foot + 1;
  })()`);
/** Message history's note that adversarial features keep nothing, and the kinds Forget is offered for. */
const historyState = () =>
  p.eval<{ note: string; forget: string[]; empty: string }>(`({
    note: document.querySelector('#set-history .hist-off')?.innerText ?? '',
    forget: [...document.querySelectorAll('#set-history .hist-forget button.danger')].map((b) => b.dataset.kind),
    empty: document.querySelector('#set-history .hist-empty')?.textContent ?? '',
  })`);
const ADVERSARIAL = ['deleted', 'disappeared', 'statuses', 'presence', 'members'];
try {
  await p.size(1280, 900);

  // Defaults: the demo's seeded deleted and disappeared messages were not kept, and no status history.
  const r0 = await retention();
  check(!r0.adversarial && !r0.deleted && !r0.disappearing && !r0.statuses && !r0.presence && !r0.members, 'adversarial features off by default', r0);
  check((await coverage()) === undefined, 'no server members recorded or shown by default');
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(500);
  check(!(await p.eval<number>(`document.querySelectorAll('.msg-gone-line').length`)), 'no kept deleted or disappeared messages in the chat');
  check(!(await p.eval<string>(`document.body.innerText`)).includes('wrong chat lol'), 'a deleted message’s words are gone');

  // Opening a chat from the sidebar: the cursor is in its box.
  await p.goto(`${hub}/#/`);
  await p.until(`document.querySelectorAll('.sidebar .conv-row[data-row]').length > 2`, 15000);
  await p.eval(`document.activeElement?.blur()`);
  await click(`.sidebar .conv-row[data-row]:nth-of-type(2)`);
  await p.until(`!!document.querySelector('.composer textarea, textarea')`, 5000);
  await Bun.sleep(300);
  const focused = await p.eval<string>(`document.activeElement?.tagName + '.' + (document.activeElement?.className ?? '')`);
  check(focused.startsWith('TEXTAREA'), 'opening a chat focuses its message box', focused);
  await p.eval(`document.activeElement?.blur()`);
  await click(`.sidebar .conv-row[data-row]:nth-of-type(3)`);
  await Bun.sleep(400);
  check((await p.eval<string>(`document.activeElement?.tagName`)) === 'TEXTAREA', 'and the next chat opened too');

  // Settings: the section is closed, behind a button.
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-adversarial')`, 10000);
  check(!(await p.eval<boolean>(`!!document.querySelector('#set-adversarial input[type=checkbox]')`)), 'no switches before the warning');
  check(!(await p.eval<string>(`document.querySelector('#set-history').innerText`)).includes('Keep deleted'), 'Message history no longer offers keeping deleted messages');
  check(
    (await p.eval<string[]>(`[...document.querySelectorAll('.settings-side .settings-nav-item')].map((b) => b.textContent.trim())`)).includes('Adversarial features') && !(await p.eval<boolean>(`!!document.querySelector('.set-jump')`)),
    'a desktop lists the sections beside Settings, with no Sections button',
  );
  // Message history says nothing adversarial is kept, and offers no Forget for what has nothing kept.
  await p.until(`!!document.querySelector('#set-history .hist-empty')`, 5000);
  let h = await historyState();
  check(/Deleted and disappearing messages, statuses, presence and server members are not being kept/.test(h.note), 'Message history says they are not being kept', h.note);
  check(!h.forget.some((k) => ADVERSARIAL.includes(k)) && h.forget.includes('edits'), 'no red Forget for kinds with nothing kept; Forget for edits stays', h.forget);
  check(/Nothing kept, so nothing to forget: deleted messages, disappeared messages, status history, presence history and server members/.test(h.empty), 'and it says why', h.empty);
  await p.eval(`[...document.querySelectorAll('#set-history .hist-off button')].find((b) => b.textContent.includes('Adversarial features')).click()`);
  await Bun.sleep(900);
  check(await inView('#set-adversarial h3'), 'its link scrolls to Adversarial features');
  await p.eval(`[...document.querySelectorAll('#set-adversarial button')].find((b) => b.textContent.includes('Show adversarial features')).click()`);
  await p.until(`!!document.querySelector('.adv-warning')`, 3000);
  const disabledAt0 = await p.eval<boolean>(`document.querySelector('.adv-confirm input').disabled`);
  check(disabledAt0, 'the warning’s Yes is greyed at first', await p.eval<string>(`document.querySelector('.adv-timer')?.textContent ?? ''`));
  if (shots) await p.shot(`${shots}/adversarial-warning.png`);
  // Ticking it while greyed does nothing.
  await click('.adv-confirm input');
  await Bun.sleep(300);
  check(!(await retention()).adversarial && !!(await p.eval<boolean>(`!!document.querySelector('.adv-warning')`)), 'a click while greyed does nothing');
  await Bun.sleep(10_000);
  check(await p.eval<boolean>(`document.querySelector('.adv-confirm input').disabled`), 'still greyed after 10 seconds');
  await p.until(`!document.querySelector('.adv-confirm input').disabled`, 7000);
  check(true, 'Yes can be ticked after 15 seconds');
  check(await p.eval<boolean>(`document.querySelector('.adv-foot').innerText.includes('Each starts off')`), 'the warning says each switch starts off');
  // Back at the top of Settings, so ticking it has to bring the switches into view.
  await p.eval(`document.querySelector('.settings-scroll').scrollTop = 0`);
  await click('.adv-confirm input');
  await p.until(`!!document.querySelector('#set-adversarial .adv-body')`, 3000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.adv-warning')`)), 'ticking it closes the warning and opens the section');
  const r1 = await retention();
  check(r1.adversarial && !r1.deleted, 'shown, but each feature still off', r1);
  await Bun.sleep(900);
  check((await p.eval<string>(`document.querySelector('#set-adversarial .adv-next')?.textContent.trim() ?? ''`)) === 'Next, turn on the ones you want. Each starts off.', 'a line says to turn on the ones wanted, each off');
  check((await inView('#set-adversarial .adv-next')) && (await inView('#set-adversarial .toggle-row')), 'that line and the first switch are in view');
  const labels = await p.eval<string[]>(`[...document.querySelectorAll('#set-adversarial .toggle-row b')].map((b) => b.textContent)`);
  check(labels.join() === 'Keep deleted messages,Keep disappearing messages,Log statuses,Log presence (online/idle/offline),Record server members (passive)', 'its switches', labels);
  const where = await p.eval<string[]>(`[...document.querySelectorAll('#set-adversarial .toggle-row .adv-where')].map((s) => s.textContent.trim())`);
  check(
    where.length === 5 && where.slice(0, 2).every((w) => w === 'Where it shows: a collapsed line in the chat') && where.slice(2, 4).every((w) => w === 'Where it shows: the Status section of a profile') && /About/.test(where[4]),
    'each switch says where it shows',
    where,
  );
  check(await p.eval<boolean>(`[...document.querySelectorAll('#set-adversarial .toggle-row input')].every((i) => !i.checked)`), 'and each is off');
  check(/not being kept/.test((await historyState()).note), 'Message history still says nothing is kept');
  // The demo's presence came while they were hidden: nothing of it was kept, and status history neither.
  const alice = boot.persons.find((x: any) => x.name === 'Alice Chen');
  const logged = (await fetch(`${hub}/api/persons/${alice.id}/changes?fields=status,presence`).then((x) => x.json())) as any;
  check(logged.changes.length === 0, 'nothing of presence or statuses was logged while hidden', logged.changes.map((c: any) => c.field));
  check((await coverage()) === undefined, 'shown, but no members coverage until its own switch');
  await p.eval(`[...document.querySelectorAll('#set-adversarial .toggle-row')].find((l) => l.textContent.includes('Keep deleted')).querySelector('input').click()`);
  await Bun.sleep(400);
  check((await retention()).deleted, 'keeping deleted messages turned on');
  h = await historyState();
  check(!h.note && h.forget.includes('deleted'), 'Message history no longer says nothing is kept, and offers Forget for deleted messages', h);
  await p.eval(`[...document.querySelectorAll('#set-adversarial .toggle-row')].find((l) => l.textContent.includes('Record server members')).querySelector('input').click()`);
  await Bun.sleep(400);
  check((await retention()).members, 'recording server members turned on');
  // The demo adapter told its members before the switch: none were kept, and the About says so.
  const cov = await coverage();
  check(cov && cov.seen === 0 && cov.total === undefined, "a server's About shows coverage, with nothing seen from before the switch", cov);
  await p.eval(`document.querySelector('#set-adversarial').scrollIntoView()`);
  if (shots) await p.shot(`${shots}/adversarial-open.png`);

  // Hiding turns them off.
  await p.eval(`[...document.querySelectorAll('#set-adversarial button')].find((b) => b.textContent.includes('Hide adversarial features')).click()`);
  await Bun.sleep(400);
  const r2 = await retention();
  check(!r2.adversarial && !r2.deleted && !r2.disappearing && !r2.statuses && !r2.presence && !r2.members, 'hiding them turns them all off', r2);
  check((await coverage()) === undefined, 'and members coverage is out of sight');
  check(!(await p.eval<boolean>(`!!document.querySelector('#set-adversarial .adv-body')`)), 'and the section closes');
  check(/not being kept/.test((await historyState()).note), 'and Message history says so again');

  // A profile's Status section without them: the current status, no history.
  await p.goto(`${hub}/#/p/${alice.id}`);
  await p.until(`!!document.querySelector('.pf-status-card')`, 10000);
  await p.eval(`document.querySelector('.pf-status-card summary').click()`);
  await Bun.sleep(200);
  const st = await p.eval<string>(`document.querySelector('.pf-status-card').innerText`);
  check(st.includes('🧗') && st.includes('since') && !/HISTORY/i.test(st) && !st.includes('Online'), 'the Status section shows the current status and no history', st.split('\n'));

  // A phone: Sections in the header, the warning's Yes on screen, the switches in view, rows a finger wide.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('.app.phone #set-adversarial')`, 10000);
  await Bun.sleep(600);
  check(await inView('.set-jump'), 'a phone has Sections at the top of Settings');
  await tap('.set-jump');
  await p.until(`!!document.querySelector('.sheet .set-sections')`, 3000);
  const sections = await p.eval<string[]>(`[...document.querySelectorAll('.set-sections .menu-item')].map((b) => b.textContent.trim())`);
  check(sections.includes('Adversarial features') && sections.includes('Message history') && sections[0] === 'Accounts', 'it lists the sections in a sheet', sections);
  if (shots) await p.shot(`${shots}/adversarial-phone-sections.png`);
  await tap('.set-sections .menu-item', `(b) => b.dataset.section === 'set-adversarial'`);
  await Bun.sleep(1000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.sheet-layer')`)) && (await inView('#set-adversarial h3')) && (await inView('#set-adversarial .btn')), 'two taps reach Adversarial features and its button');
  await tap('#set-adversarial .btn', `(b) => b.textContent.includes('Show adversarial features')`);
  await p.until(`!!document.querySelector('.adv-warning')`, 3000);
  await Bun.sleep(500);
  const sheet = await p.eval<any>(`(() => {
    const yes = document.querySelector('.adv-confirm').getBoundingClientRect();
    const text = document.querySelector('.adv-text');
    return { yesTop: Math.round(yes.top), yesBottom: Math.round(yes.bottom), height: innerHeight, scrolled: text.scrollTop + document.querySelector('.modal-body').scrollTop, more: text.scrollHeight > text.clientHeight };
  })()`);
  check(sheet.yesTop >= 0 && sheet.yesBottom <= sheet.height && sheet.scrolled === 0, "the warning's Yes is on screen without scrolling", sheet);
  check(await inView('.adv-foot small'), 'and so is what it does');
  if (shots) await p.shot(`${shots}/adversarial-phone-warning.png`);
  await p.until(`!document.querySelector('.adv-confirm input').disabled`, 17000);
  await tap('.adv-confirm input');
  await p.until(`!!document.querySelector('#set-adversarial .adv-body')`, 3000);
  await Bun.sleep(1000);
  check((await retention()).adversarial && !(await p.eval<boolean>(`!!document.querySelector('.adv-warning')`)), 'a tap on Yes shows them');
  check((await inView('#set-adversarial .adv-next')) && (await inView('#set-adversarial .toggle-row')), 'the each-starts-off line and the first switch are in view');
  if (shots) await p.shot(`${shots}/adversarial-phone-open.png`);
  const rows = await p.eval<number[]>(`[...document.querySelectorAll('.settings .toggle-row')].map((l) => Math.round(l.getBoundingClientRect().height))`);
  check(rows.length > 5 && rows.every((x) => x >= 44), 'every switch row in Settings is at least 44px tall', rows);
  const cells = await p.eval<number[]>(`[...document.querySelectorAll('#set-adversarial .hist-cell')].map((c) => Math.round(Math.min(c.getBoundingClientRect().width, c.getBoundingClientRect().height)))`);
  check(cells.length > 0 && cells.every((x) => x >= 44), 'and each box in the table by network is 44px', cells);
  await tap('#set-adversarial .toggle-row', `(l) => l.textContent.includes('Keep deleted')`);
  await Bun.sleep(400);
  check((await retention()).deleted, 'a tap on the Deleted row turns it on');
  await tap('.set-jump');
  await tap('.set-sections .menu-item', `(b) => b.dataset.section === 'set-history'`);
  await Bun.sleep(1000);
  check((await inView('#set-history h3')) && !(await historyState()).note, 'Sections reaches Message history, which no longer says nothing is kept');
  await p.eval(`[...document.querySelectorAll('#set-adversarial button')].find((b) => b.textContent.includes('Hide adversarial features')).click()`);
  await Bun.sleep(400);
  check(!(await retention()).adversarial, 'hidden again');
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
