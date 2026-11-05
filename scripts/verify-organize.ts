/**
 * Organizing servers by meaning, Discord-style tooltips and the start screen, end to end against a demo hub in
 * headless Chromium (docs/organize.md, ui/Tooltip.tsx, ui/Loader.tsx):
 * - the page starts with the loader's sphere drawn before any script, and the app replaces it;
 * - pointing at a server in the rail shows its name in a bubble to its right, with no browser tooltip;
 * - a suggested folder's sensitivity slider takes in more or fewer servers as it moves, and is saved;
 * - "By meaning" asks the categorizer about every server, shows how sure it is, filters by the slider, and saves the
 *   question as a category.
 *
 *   bun scripts/verify-organize.ts http://127.0.0.1:8531 [/tmp/shots]
 * The hub must be a fresh demo hub with its own data dir: this saves a threshold and adds a category. With
 * DITHER_CATEGORY_MODEL=jev on the hub, it asks the machine's reranker; otherwise keywords.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8531';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
const b0 = await bootstrap();
if (!b0.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const center = (sel: string) =>
  p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
async function click(sel: string) {
  const r = await center(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
}
const hover = async (sel: string) => {
  const r = await center(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
};
/** Moves a range input as a person would end a drag: input events, then change. */
const slide = (sel: string, v: number) =>
  p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('no slider ' + ${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(e, '${v}'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const typeText = async (text: string) => {
  for (const ch of text) await p.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
};

try {
  await p.size(1280, 900);

  // The start screen: index.html draws the sphere before any script runs.
  const html = await fetch(`${hub}/`).then((r) => r.text());
  check(html.includes('id="boot-static"') && /<path fill="currentColor" d="M\d/.test(html), 'index.html draws the loader’s first frame');
  await p.goto(`${hub}/#/`);
  await p.until(`!!document.querySelector('.rail .rail-btn')`, 15000);
  check(!(await p.eval<boolean>(`!!document.getElementById('boot-static') || !!document.querySelector('.boot-screen')`)), 'the app replaces the start screen once loaded');

  // Tooltips.
  const key = await p.eval<string>(`[...document.querySelectorAll('.rail-scroll .rail-item[data-dnd-key^="space:"]')].map((e) => e.dataset.dndKey).find((k) => true)`);
  const space = b0.spaces.find((s: any) => `space:${s.id}` === key);
  const sel = `.rail-item[data-dnd-key="${key}"] .rail-btn`;
  check(space && (await p.eval<boolean>(`!document.querySelector(${JSON.stringify(sel)}).hasAttribute('title')`)), 'rail buttons have no browser tooltip', key);
  await hover(sel);
  await Bun.sleep(250);
  const tip = await p.eval<any>(`(() => { const t = document.querySelector('.tooltip.shown'); const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); if (!t) return null; const r = t.getBoundingClientRect(); return { name: t.querySelector('b')?.textContent, sub: t.querySelector('small')?.textContent, right: r.left > b.right, middle: Math.abs((r.top + r.bottom) / 2 - (b.top + b.bottom) / 2) }; })()`);
  check(tip?.name === space.name && /server|space|group/.test(tip?.sub ?? '') && tip.right && tip.middle < 2, 'pointing at a server shows its name beside it', tip);
  if (shots) await p.shot(`${shots}/tooltip.png`);
  await hover('.timeline, .main, body');
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 450 });
  await Bun.sleep(100);
  check(!(await p.eval<boolean>(`!!document.querySelector('.tooltip')`)), 'and hides it when the pointer leaves');

  // The Organize view. The demo files its servers into folders: empty them, so there is something to suggest.
  await fetch(`${hub}/api/folders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folders: [] }) });
  await p.goto(`${hub}/#/`);
  await p.until(`document.querySelectorAll('.rail-scroll .rail-item[data-dnd-key^="space:"]').length > 4`, 15000);
  await click('.rail-sort .rail-btn');
  await p.until(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].some((e) => e.textContent.includes('Organize Servers'))`, 5000);
  await p.eval(`[...document.querySelectorAll('.cm-item, [role=menuitem]')].find((e) => e.textContent.includes('Organize Servers')).click()`);
  await p.until(`!!document.querySelector('.org')`, 5000);
  const cards = () => p.eval<{ name: string; n: number; disabled: boolean }[]>(`[...document.querySelectorAll('.org-sugg')].map((c) => ({ name: c.querySelector('b').textContent.trim(), n: +c.querySelector('.sensitivity-count').textContent, disabled: c.querySelector('.btn.primary').disabled }))`);
  const before = await cards();
  check(before.length > 0, 'suggested folders, each with a sensitivity slider', before);
  const first = before[0];
  const cardSel = `.org-sugg:nth-child(1) input[type=range]`;
  await slide(cardSel, 100);
  await Bun.sleep(150);
  const more = (await cards()).find((c) => c.name === first.name)!;
  await slide(cardSel, 0);
  await Bun.sleep(150);
  const none = (await cards()).find((c) => c.name === first.name);
  check(more.n >= first.n && none?.n === 0 && none.disabled, 'More takes in more servers, Fewer none (the card stays, its Create off)', { first, more, none });
  await slide(cardSel, 60);
  await Bun.sleep(600);
  const cat = (await bootstrap()).categories.find((c: any) => first.name.includes(c.name));
  check(cat && Math.abs(cat.threshold - 10 ** (-3 * 0.6)) < 0.001, 'the threshold is saved on the hub', cat?.threshold);

  // By meaning.
  await click('.org-meaning');
  await p.eval(`document.querySelector('.org-search input').focus()`);
  await typeText('rust');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await p.until(`!!document.querySelector('.org-probe .sensitivity')`, 60000);
  const rows = () => p.eval<{ name: string; score: string }[]>(`[...document.querySelectorAll('.org-row')].map((r) => ({ name: r.querySelector('.org-name').textContent, score: r.querySelector('.org-score')?.textContent }))`);
  const asked = await rows();
  check(asked.length > 0 && asked.every((r) => r.score?.endsWith('%')) && /rust/i.test(asked[0].name), 'by meaning: matches with how sure it is, best first', asked.slice(0, 4));
  if (shots) await p.shot(`${shots}/by-meaning.png`);
  await slide('.org-probe input[type=range]', 100);
  await Bun.sleep(100);
  const all = (await rows()).length;
  await slide('.org-probe input[type=range]', 0);
  await Bun.sleep(100);
  const fewest = (await rows()).length;
  check(all >= asked.length && fewest <= asked.length, 'the slider filters more or fewer', { fewest, asked: asked.length, all });
  await slide('.org-probe input[type=range]', 40);
  await Bun.sleep(100);
  await p.eval(`[...document.querySelectorAll('.org-probe button')].find((b) => b.textContent.includes('Save as category')).click()`);
  await p.until(`fetch('/api/bootstrap').then((r) => r.json()).then((b) => b.categories.some((c) => c.name === 'Rust'))`, 5000).catch(() => {});
  const saved = (await bootstrap()).categories.find((c: any) => c.name === 'Rust');
  check(saved?.question === 'Is this community about rust?' && saved.threshold > 0, 'and saves the question as a category with its threshold', saved);
  if (shots) await p.shot(`${shots}/organize.png`);
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
