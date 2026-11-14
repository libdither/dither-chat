/**
 * Opening a server goes back to the channel last opened in it (docs/servers.md "Opening a server"), end to end against
 * a demo hub in headless Chromium:
 * - a server never opened opens on its first channel to read (the demo's first is a text one);
 * - after a channel is opened there, opening another server and coming back opens that channel again;
 * - it is still so after a reload (kept on the device);
 * - on a phone the server opens on its list.
 *
 *   bun scripts/verify-server-channel.ts http://127.0.0.1:8531 [/tmp/shots]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8531';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const b0 = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!b0.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
async function click(sel: string, nth = 0) {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
const hash = () => p.eval<string>('location.hash');
const railSel = (id: string) => `.rail-item[data-dnd-key="space:${id}"] .rail-btn`;

try {
  await p.size(1280, 900);
  // The demo files servers into folders: empty them, so every server is a button on the rail.
  await fetch(`${hub}/api/folders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [] }) });
  await p.goto(`${hub}/#/`);
  await p.until(`document.querySelectorAll('.rail-scroll .rail-item[data-dnd-key^="space:"]').length > 1`, 15000);
  const [a, b] = await p.eval<string[]>(`[...document.querySelectorAll('.rail-scroll .rail-item[data-dnd-key^="space:"]')].map((e) => e.dataset.dndKey.slice(6)).slice(0, 2)`);

  await click(railSel(a));
  await p.until(`location.hash.startsWith(${JSON.stringify(`#/s/${encodeURIComponent(a)}/c/`)}) && document.querySelectorAll('.chan').length > 1`, 5000);
  check(await p.eval<boolean>(`document.querySelector('.chan') === document.querySelector('.chan.active')`), 'a server never opened opens on its first channel', await hash());

  // Open its second channel, so it is not just the first one by chance.
  await click('.chan', 1);
  await p.until(`location.hash.includes('/c/')`, 5000);
  const opened = await hash();
  check(opened.startsWith(`#/s/${encodeURIComponent(a)}/c/`), 'a channel opened in it', opened);

  await click(railSel(b));
  await p.until(`location.hash.startsWith(${JSON.stringify(`#/s/${encodeURIComponent(b)}`)})`, 5000);
  await click(railSel(a));
  await p.until(`location.hash.startsWith(${JSON.stringify(`#/s/${encodeURIComponent(a)}`)})`, 5000);
  check((await hash()) === opened, 'back to the server: its last channel opens', await hash());
  check(await p.eval<boolean>(`!!document.querySelector('.chan.active') && !document.querySelector('.welcome')`), 'with the channel shown and marked in the list');
  if (shots) await p.shot(`${shots}/back-to-channel.png`);

  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector(${JSON.stringify(railSel(a))})`, 15000);
  await click(railSel(a));
  await p.until(`location.hash.startsWith(${JSON.stringify(`#/s/${encodeURIComponent(a)}`)})`, 5000);
  check((await hash()) === opened, 'still so after a reload', await hash());

  // A phone opens the server on its list.
  await p.size(400, 800);
  await p.eval(`location.hash = '#/spaces'`);
  await p.until(`location.hash === '#/spaces'`, 5000);
  await p.until(`[...document.querySelectorAll('button')].some((e) => e.textContent.includes(${JSON.stringify(b0.spaces.find((s: any) => s.id === a)?.name ?? '')}))`, 5000);
  await p.eval(`[...document.querySelectorAll('.side-scroll button')].find((e) => e.textContent.includes(${JSON.stringify(b0.spaces.find((s: any) => s.id === a)?.name ?? '')}))?.click()`);
  await p.until(`location.hash.startsWith(${JSON.stringify(`#/s/${encodeURIComponent(a)}`)})`, 5000);
  check(!(await hash()).includes('/c/'), 'on a phone the server opens on its list', await hash());
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
