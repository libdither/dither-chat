/**
 * Adversarial features (docs/history.md) and the composer taking focus, end to end against a demo hub in headless
 * Chromium: by default nothing deleted or disappeared is kept and the switches are out of sight; the warning's "Yes"
 * stays greyed for 15 seconds; ticking it shows the switches, which then keep what is deleted; hiding them turns
 * them off again. Opening a chat from the sidebar puts the cursor in its message box.
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

const { page: p, close } = await launch();
await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
async function click(selector: string) {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
try {
  await p.size(1280, 900);

  // Defaults: the demo's seeded deleted and disappeared messages were not kept, and no status history.
  const r0 = await retention();
  check(!r0.adversarial && !r0.deleted && !r0.disappearing && !r0.statuses, 'adversarial features off by default', r0);
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
  await click('.adv-confirm input');
  await p.until(`!!document.querySelector('#set-adversarial .adv-body')`, 3000);
  check(!(await p.eval<boolean>(`!!document.querySelector('.adv-warning')`)), 'ticking it closes the warning and opens the section');
  const r1 = await retention();
  check(r1.adversarial && !r1.deleted, 'shown, but each feature still off', r1);
  const labels = await p.eval<string[]>(`[...document.querySelectorAll('#set-adversarial .toggle-row b')].map((b) => b.textContent)`);
  check(labels.join() === 'Keep deleted messages,Keep disappearing messages,Log statuses', 'its switches', labels);
  await p.eval(`[...document.querySelectorAll('#set-adversarial .toggle-row')].find((l) => l.textContent.includes('Keep deleted')).querySelector('input').click()`);
  await Bun.sleep(400);
  check((await retention()).deleted, 'keeping deleted messages turned on');
  await p.eval(`document.querySelector('#set-adversarial').scrollIntoView()`);
  if (shots) await p.shot(`${shots}/adversarial-open.png`);

  // Hiding turns them off.
  await p.eval(`[...document.querySelectorAll('#set-adversarial button')].find((b) => b.textContent.includes('Hide adversarial features')).click()`);
  await Bun.sleep(400);
  const r2 = await retention();
  check(!r2.adversarial && !r2.deleted && !r2.disappearing && !r2.statuses, 'hiding them turns them all off', r2);
  check(!(await p.eval<boolean>(`!!document.querySelector('#set-adversarial .adv-body')`)), 'and the section closes');
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
