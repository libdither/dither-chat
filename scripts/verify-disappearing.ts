/**
 * The message box's disappearing-messages button (docs/group-settings.md, "In the message box"), end to end against a
 * demo hub in headless Chromium: a Signal group with a week's timer shows it over the box, a click opens Signal's
 * timers and a pick reaches the network; a 1:1 Signal chat shows a quiet clock after "To … on Signal", and turning a
 * timer on there shows it; Discord has no clock; the same on a phone.
 *
 *   bun scripts/verify-disappearing.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this changes timers.
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
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? null)} === null || x.textContent.trim() === ${JSON.stringify(text ?? '')})); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}${text ? ` "${text}"` : ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const button = () => p.eval<{ text: string; on: boolean; left: number; leadRight: number } | null>(
  `(() => { const b = document.querySelector('.typing-lead .disappearing-btn'); if (!b) return null; const l = document.querySelector('.typing-lead .pair-token'); return { text: b.textContent.trim(), on: b.classList.contains('on'), left: b.getBoundingClientRect().left, leadRight: l ? l.getBoundingClientRect().right : 0 }; })()`,
);

try {
  for (const [w, h, name] of [[1280, 860, 'computer'], [400, 860, 'phone']] as const) {
    await p.size(w, h);
    // A group with a week's timer.
    await p.goto(`${hub}/#/c/${climb}`);
    await p.until(`document.querySelectorAll('.msg').length > 1 && !!document.querySelector('.typing-lead .disappearing-btn')`, 15000);
    const g = await button();
    check(g?.on && g.text === (name === 'computer' ? '1 week' : '1 day'), `${name}: the group's timer shows over the box`, g);
    if (shots) await p.shot(`${shots}/${name}-group.png`);
    await click('.typing-lead .disappearing-btn');
    await p.until(`[...document.querySelectorAll('.menu-item')].some((e) => e.textContent.trim() === '1 day')`, 4000);
    const offered = await p.eval<string[]>(`[...document.querySelectorAll('.pair-menu .menu-item')].map((e) => e.textContent.trim())`);
    check(offered[0] === 'Off' && offered.includes('30 seconds') && offered.includes('4 weeks'), `${name}: Signal's own timers are offered`, offered);
    if (shots) await p.shot(`${shots}/${name}-group-menu.png`);
    const next = name === 'computer' ? '1 day' : '1 week';
    await click('.pair-menu .menu-item', next);
    await p.until(`document.querySelector('.typing-lead .disappearing-btn')?.textContent.trim() === ${JSON.stringify(next)}`, 6000);
    check((await timer(climb)) === (next === '1 day' ? 86_400 : 604_800), `${name}: the pick reached the network (${next})`);

    // A 1:1 chat: a quiet clock after where the message goes.
    await p.goto(`${hub}/#/c/${dm}`);
    await p.until(`!!document.querySelector('.typing-lead .disappearing-btn')`, 15000);
    const d = await button();
    check(d && d.left >= d.leadRight, `${name}: the 1:1 chat's clock sits right of "To … on Signal"`, d);
    if (shots) await p.shot(`${shots}/${name}-dm.png`);
    if (name === 'computer') {
      check(d && !d.on && d.text === '', 'computer: off is a quiet clock with no words', d);
      await click('.typing-lead .disappearing-btn');
      await p.until(`[...document.querySelectorAll('.pair-menu .menu-item')].some((e) => e.textContent.trim() === '30 seconds')`, 4000);
      await click('.pair-menu .menu-item', '30 seconds');
      await p.until(`document.querySelector('.typing-lead .disappearing-btn.on')?.textContent.trim() === '30 seconds'`, 6000);
      check((await timer(dm)) === 30, 'computer: a 1:1 timer turned on reaches the network');
      if (shots) await p.shot(`${shots}/${name}-dm-on.png`);
    }

    // Discord has no timer.
    await p.goto(`${hub}/#/c/${general}`);
    await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
    await Bun.sleep(300);
    check(!(await p.eval(`!!document.querySelector('.disappearing-btn')`)), `${name}: no clock on Discord`);
  }
} catch (e) {
  console.log(`FAIL ${(e as Error).message}`);
  failures++;
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
