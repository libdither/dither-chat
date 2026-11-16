/**
 * Disappearing messages in the message box (docs/group-settings.md, "In the message box"), end to end against a demo
 * hub in headless Chromium, on a computer and a phone: a Signal group with a week's timer says so at the end of the line
 * above the box, and a message sent there shows "1w"; the send menu's Disappearing messages line opens Signal's timers
 * and a pick reaches the network; a 1:1 chat with no timer has no label until one is turned on, and a press on the
 * label turns it off again; Discord has neither the line nor the label.
 *
 *   bun scripts/verify-disappearing.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this changes timers and sends demo messages.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const climb = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Climbing crew 🧗')?.id;
const dm = boot.conversations.find((c: any) => c.network === 'signal' && c.shape === 'direct' && !c.pending && c.lastMessageAt)?.id;
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general')?.id;
if (!climb || !dm || !general) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const timer = (id: string) => fetch(`${hub}/api/conversations/${id}/about`).then((r) => r.json()).then((v: any) => v.fields.disappearing?.value);

const { page: p, close } = await launch();
const at = (sel: string, text?: string) =>
  p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? null)} === null || x.textContent.trim().startsWith(${JSON.stringify(text ?? '')}))); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
const click = async (sel: string, text?: string, button: 'left' | 'right' = 'left') => {
  // The demo world's notices pop up as toasts over the box's corner: out of the way, so a press lands on send.
  await p.eval(`document.querySelector('.toasts')?.style.setProperty('display', 'none')`);
  const r = await at(sel, text);
  if (!r) throw new Error(`nothing matches ${sel}${text ? ` "${text}"` : ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button, clickCount: 1 });
};
const label = () => p.eval<string | null>(`document.querySelector('.typing-lead .timer-label')?.textContent.trim() ?? null`);
const badge = async () => (await label()) !== null;
const write = async (text: string) => {
  await click('.composer textarea');
  await p.send('Input.insertText', { text });
  await p.until(`!!document.querySelector('.composer .send-btn:not([disabled])')`, 4000);
};
// The send menu: a computer's arrow beside send; a phone's send held (a right-click with a mouse), which needs text.
const openMenu = async (phone: boolean) => {
  if (phone) {
    await write('x');
    await click('.composer .send-btn', undefined, 'right');
  } else await click('.composer .send-more');
  await p.until(`!!document.querySelector('.level-menu [data-track="send later"]')`, 4000);
  // A phone's menu is a sheet that slides up: press its lines once it has stopped.
  if (phone) await p.until(`(document.querySelector('.sheet-layer')?.getAnimations({ subtree: true }) ?? []).every((a) => a.playState !== 'running')`, 4000);
};
const line = () => p.eval<string | null>(`document.querySelector('.level-menu [data-track="disappearing messages"]')?.textContent.trim() ?? null`);
const pick = async (phone: boolean, label: string, open = true) => {
  if (open) await openMenu(phone);
  await click('.level-menu [data-track="disappearing messages"]');
  await p.until(`[...document.querySelectorAll('.send-timers .menu-item')].some((e) => e.textContent.trim() === ${JSON.stringify(label)})`, 4000);
  if (shots) await p.shot(`${shots}/${phone ? 'phone' : 'computer'}-menu-${label.replace(/ /g, '')}.png`);
  await click('.send-timers .menu-item', label);
};
const clearBox = () => p.eval(`(() => { const t = document.querySelector('.composer textarea'); if (!t) return; t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);

try {
  for (const [w, h, name] of [[1280, 860, 'computer'], [400, 860, 'phone']] as const) {
    const phone = name === 'phone';
    await p.size(w, h);

    // A group with a week's timer: the stopwatch on send, and a message that shows its timer.
    await p.goto(`${hub}/#/c/${climb}`);
    await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
    const week = phone ? '1 day' : '1 week';
    await p.until(`!!document.querySelector('.typing-lead .timer-label')`, 8000).catch(() => {});
    check((await label()) === `Disappears after ${week}`, `${name}: the line above the box says the group's timer`, await label());
    await write(`on my way (${name})`);
    await click('.composer .send-btn');
    await p.until(`[...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('on my way (${name})') && m.querySelector('.msg-disappears'))`, 8000);
    const mark = await p.eval<{ text: string; title: string }>(`(() => { const m = [...document.querySelectorAll('.msg')].filter((m) => m.textContent.includes('on my way (${name})') && m.querySelector('.msg-disappears')).pop().querySelector('.msg-disappears'); return { text: m.textContent.trim(), title: m.title }; })()`);
    check(mark.text === (phone ? '1d' : '1w') && mark.title.startsWith('Disappears '), `${name}: the message sent shows its timer`, mark);
    if (shots) await p.shot(`${shots}/${name}-group.png`);

    // The send menu's line, then a pick.
    await openMenu(phone);
    check((await line())?.includes(week), `${name}: the send menu says the timer`, await line());
    const next = phone ? '1 week' : '1 day';
    await pick(phone, next, false);
    await p.until(`!document.querySelector('.send-timers')`, 4000);
    await Bun.sleep(300);
    check((await timer(climb)) === (next === '1 day' ? 86_400 : 604_800), `${name}: the pick reached the network (${next})`);
    await clearBox();

    // A 1:1 chat with no timer: no stopwatch, until one is turned on.
    await p.goto(`${hub}/#/c/${dm}`);
    await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
    await Bun.sleep(400);
    check(!(await badge()), `${name}: no label while off`);
    await pick(phone, '30 seconds');
    await p.until(`!!document.querySelector('.typing-lead .timer-label')`, 6000);
    check((await timer(dm)) === 30, `${name}: a 1:1 timer turned on reaches the network`);
    check((await label())?.endsWith('30s') || (await label()) === 'Disappears after 30 seconds', `${name}: the line above the box shows it once it is on`, await label());
    if (shots) await p.shot(`${shots}/${name}-dm-on.png`);
    await clearBox();
    // Off from the label itself: its press opens the timers.
    await click('.typing-lead .timer-label');
    await p.until(`[...document.querySelectorAll('.level-menu .menu-item')].some((e) => e.textContent.trim() === 'Off')`, 4000);
    if (phone) await p.until(`(document.querySelector('.sheet-layer')?.getAnimations({ subtree: true }) ?? []).every((a) => a.playState !== 'running')`, 4000);
    await click('.level-menu .menu-item', 'Off');
    await p.until(`!document.querySelector('.typing-lead .timer-label')`, 6000);
    check((await timer(dm)) === 0, `${name}: and off again from the label`);
    await clearBox();

    // Discord: no timer at all.
    await p.goto(`${hub}/#/c/${general}`);
    await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
    await openMenu(phone);
    check((await line()) === null && !(await badge()), `${name}: Discord has no Disappearing line and no label`);
    if (shots) await p.shot(`${shots}/${name}-discord-menu.png`);
    await clearBox();
  }
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`);
  if (shots) await p.shot(`${shots}/failed.png`);
  failures++;
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
