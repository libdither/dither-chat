/**
 * The reaction picker and the add button (docs/reactions.md), end to end against a demo hub in headless Chromium:
 * Discord's layout (category rail, named emoji along the bottom), emoji drawn whole rather than clipped, hovering and
 * scrolling leaving the grid untouched, and on Signal, where one reaction per person is kept, the add button and the
 * picker saying a pick replaces yours, and a pick doing so.
 *
 *   bun scripts/verify-reactions.ts http://127.0.0.1:8482 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this reacts to messages.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8482';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const group = (network: string) => boot.conversations.find((c: any) => c.network === network && c.shape === 'group')?.id;
const discord = group('discord');
const signal = group('signal');
if (!discord || !signal) throw new Error('the demo world has no Discord or Signal group');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const at = (sel: string, idx = -1) =>
  p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getBoundingClientRect().width > 0).at(${idx}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 14) }; })()`,
  );
const move = async (sel: string, idx = -1) => {
  const r = await at(sel, idx);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  return r;
};
const click = async (sel: string, idx = -1) => {
  const r = await move(sel, idx);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const openPicker = async () => {
  await move('.msg:not(.system)');
  await Bun.sleep(250);
  await click('.msg-actions button[aria-label="More reactions"]');
  await p.until(`!!document.querySelector('.emoji-picker .ep-emoji')`, 8000);
  await Bun.sleep(300);
};
const escape = () => p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

try {
  await p.size(1280, 860);
  await p.goto(`${hub}/#/c/${discord}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(500);

  // Discord's layout.
  await openPicker();
  const rail = await p.eval<string[]>(`[...document.querySelectorAll('.ep-rail-btn')].map((b) => b.title)`);
  check(rail[0] === 'Frequently used' && rail.includes('Flags') && rail.includes('This server'), 'a rail of categories: frequent, each server, then Unicode', rail);
  await move('.ep-emoji', 30);
  await Bun.sleep(150);
  const foot = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/^\S+:[a-z0-9_+-]+:$/.test(foot.trim()), 'the emoji under the pointer is named along the bottom', foot);
  await click('.ep-rail-btn[title="Flags"]', 0);
  await Bun.sleep(250);
  check((await p.eval(`document.querySelector('.ep-rail-btn.on')?.title`)) === 'Flags', 'the rail jumps to a category and marks it');
  if (shots) await p.shot(`${shots}/reactions-discord.png`);

  // Drawn whole: the glyph inside its cell, nothing clipping it vertically.
  const clip = await p.eval<{ over: number; overflow: string }[]>(`[...document.querySelectorAll('.ep-emoji')].slice(20, 60).map((b) => { const s = b.querySelector('.emoji-text'); const r = document.createRange(); r.selectNodeContents(s); const g = r.getBoundingClientRect(); const c = b.getBoundingClientRect(); return { over: Math.max(c.top - g.top, g.bottom - c.bottom), overflow: getComputedStyle(s).overflowY }; })`);
  check(clip.length > 0 && clip.every((c) => c.over <= 0 && c.overflow === 'visible'), 'emoji are drawn whole inside their cells', clip.slice(0, 3));

  // No flicker: hovering and scrolling change the footer and the rail, never the grid's cells.
  const churn = await p.eval<Record<string, number>>(`new Promise(async (res) => {
    const grid = document.querySelector('.ep-scroll');
    const where = {};
    const mo = new MutationObserver((ms) => { for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; const k = el.closest('.ep-foot') ? 'foot' : el.closest('.ep-rail') ? 'rail' : el.closest('.ep-emoji') ? 'cells' : 'other'; where[k] = (where[k] ?? 0) + 1; } });
    const picker = document.querySelector('.emoji-picker');
    if (!picker) return res({ closed: 1 });
    mo.observe(picker, { subtree: true, childList: true, attributes: true, characterData: true });
    const cells = [...document.querySelectorAll('.ep-emoji')];
    for (let i = 30; i < 80; i++) { cells[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); }
    for (let i = 0; i <= 20; i++) { grid.scrollTop = i * 400; await new Promise((r) => requestAnimationFrame(r)); }
    await new Promise((r) => setTimeout(r, 100));
    mo.disconnect();
    res(where);
  })`);
  check(!churn.cells && !churn.other && (churn.foot ?? 0) > 0, 'hovering and scrolling change only the footer and the rail', churn);
  await escape();
  await Bun.sleep(200);
  const plain = await p.eval<string | null>(`[...document.querySelectorAll('.msg-actions button[aria-label="More reactions"]')].at(-1)?.className ?? null`);
  check(plain !== null && !plain.includes('swap'), 'on Discord the add button adds', plain);

  // Signal keeps one reaction per person.
  await p.goto(`${hub}/#/c/${signal}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(500);
  const last = (await fetch(`${hub}/api/conversations/${signal}/messages?limit=1`).then((r) => r.json())) as any;
  const mid = last.messages.at(-1).id;
  const reacted = await fetch(`${hub}/api/messages/${mid}/react`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '👍' }) });
  check(reacted.ok, 'reacted 👍 on Signal');
  await p.until(`[...document.querySelectorAll('.reaction.mine')].some((r) => r.textContent.includes('👍'))`, 8000);
  await move('.msg:not(.system)');
  await Bun.sleep(300);
  const row = await p.eval<{ cls: string; title: string }[]>(`[...document.querySelectorAll('.msg-actions button')].filter((b) => b.getBoundingClientRect().width).slice(0, 4).map((b) => ({ cls: b.className, title: b.title }))`);
  const add = row.find((b) => b.cls.includes('swap'));
  check(add && /keeps one per person/.test(add.title), 'on Signal, with a reaction of yours, the add button shows the swap icon', add);
  check(row.some((b) => b.cls.includes('on') && b.title.includes('Take back your 👍')), 'your reaction is marked in the quick row', row.map((b) => b.title));
  const pill = await p.eval<string | null>(`[...document.querySelectorAll('.reaction.add')].at(-1)?.className ?? null`);
  check(pill?.includes('swap'), 'the add button beside the pills swaps too', pill);
  if (shots) await p.shot(`${shots}/reactions-signal-row.png`);
  await openPicker();
  const idle = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/keeps one reaction per person: a pick replaces your 👍/.test(idle), 'the picker says a pick replaces yours', idle);
  const joy = await p.eval<number>(`[...document.querySelectorAll('.ep-emoji')].findIndex((b) => b.getAttribute('aria-label') === ':joy:')`);
  await move('.ep-emoji', joy);
  await Bun.sleep(150);
  const hover = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/:joy:.*replaces/.test(hover), 'hovering another emoji says it replaces yours', hover);
  if (shots) await p.shot(`${shots}/reactions-signal-picker.png`);
  await click('.ep-emoji', joy);
  await Bun.sleep(1200);
  const after = ((await fetch(`${hub}/api/conversations/${signal}/messages?limit=1`).then((r) => r.json())) as any).messages.at(-1).reactions.filter((r: any) => r.identityIds.length && r.key);
  const mine = after.filter((r: any) => r.identityIds.some((i: string) => boot.accounts.some((a: any) => a.selfIdentityId === i)));
  check(mine.length === 1 && mine[0].key === '😂', 'picking 😂 replaced your 👍', mine.map((r: any) => r.key));
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
