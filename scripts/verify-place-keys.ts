/**
 * Keys to the places (packages/web/src/ui/PlaceKeys.tsx, docs/desktop.md "Keys to the places") in a real browser
 * against a fresh demo hub, with real key input:
 *
 *   - G then P goes to People, G then I back to the inbox, and the card shows while G waits;
 *   - another key after G puts the card away and goes nowhere;
 *   - G typed in the message box is just a letter; Alt+2 from the box goes to People;
 *   - the rail's tooltips list the keys.
 *
 *   bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-place-keys.ts http://127.0.0.1:<port> [screenshot dir]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-place-keys.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json() as Promise<any>);
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub: refusing');

const { page, close } = await launch();
const ALT = 1;
/** A real key press: down (with its text, so a field types it) and up. */
const press = async (key: string, code: string, vk: number, modifiers = 0) => {
  const text = modifiers ? {} : { text: key };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
};
const letter = (l: string) => press(l, `Key${l.toUpperCase()}`, l.toUpperCase().charCodeAt(0));
const hash = () => page.eval<string>('location.hash');
const card = () => page.eval<boolean>(`!!document.querySelector('.place-keys')`);

try {
  await page.size(1400, 900);
  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.rail-btn[data-track="people"]')`, 20000);
  await page.eval(`document.activeElement?.blur()`);

  await letter('g');
  check('G brings up the card', await card());
  if (shots) await page.shot(`${shots}/card.png`);
  await letter('p');
  await page.until(`location.hash.startsWith('#/people')`, 3000).catch(() => {});
  check('G then P goes to People', (await hash()).startsWith('#/people'), await hash());
  check('…and the card goes', !(await card()));

  await letter('g');
  await letter('i');
  await page.until(`location.hash.startsWith('#/inbox')`, 3000).catch(() => {});
  check('G then I goes to the inbox', (await hash()).startsWith('#/inbox'), await hash());

  await letter('g');
  await letter('x');
  check('another key after G puts the card away', !(await card()));
  check('…and goes nowhere', (await hash()).startsWith('#/inbox'), await hash());

  // A chat: its box takes the focus as it opens.
  const conv = boot.conversations.find((c: any) => c.shape === 'direct') ?? boot.conversations[0];
  await page.goto(`${base}/#/inbox/c/${encodeURIComponent(conv.id)}`);
  await page.until(`document.activeElement?.tagName === 'TEXTAREA'`, 10000).catch(() => {});
  const inBox = await page.eval<boolean>(`document.activeElement?.tagName === 'TEXTAREA'`);
  check('opening a chat puts you in its box', inBox);
  await letter('g');
  await letter('p');
  const typed = await page.eval<string>(`document.activeElement?.value ?? ''`);
  check('in the box, G and P are just letters', typed.endsWith('gp') && (await hash()).startsWith('#/inbox'), { typed, hash: await hash() });
  check('…and no card', !(await card()));
  await press('2', 'Digit2', 50, ALT);
  await page.until(`location.hash.startsWith('#/people')`, 3000).catch(() => {});
  check('Alt+2 from the box goes to People', (await hash()).startsWith('#/people'), await hash());

  // The rail's tooltips.
  const rect = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.rail-btn[data-track="people"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await page.until(`!!document.querySelector('.tooltip .tip-keys')`, 3000).catch(() => {});
  const tip = await page.eval<string>(`document.querySelector('.tooltip .tip-keys')?.textContent ?? ''`);
  check("People's tooltip lists Alt+2 and G P", tip.replace(/\s/g, '') === 'Alt+2orGP', tip);
  if (shots) await page.shot(`${shots}/tooltip.png`);
  check('no page errors', page.errors.length === 0, page.errors);
} finally {
  await close();
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
