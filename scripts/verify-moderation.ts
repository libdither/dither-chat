/**
 * Moderating (docs/moderation.md), end to end against a demo hub in headless Chromium: a Signal group you administer
 * shows the Moderation and label cards and a picture button; a member's menu offers remove, ban and admin; removing
 * someone goes through after a confirm and they leave the list; your label saves; a Discord server you run offers
 * kick, roles and timeouts on a member and nothing on someone as high as you; another account sees no Moderation card;
 * someone else's message in a channel you moderate offers a moderator's delete.
 *
 *   bun scripts/verify-moderation.ts http://127.0.0.1:8497
 * The hub must be a fresh demo hub (--demo) with its own data dir: this removes people and changes things.
 */
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const climb = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Climbing crew 🧗')?.id;
const dither = boot.spaces.find((s: any) => s.network === 'discord' && s.name === 'libdither')?.id;
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general' && c.vantages.length === 2)?.id;
if (!climb || !dither || !general) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const { page: p, close } = await launch();
const opened = () => p.until(`!!document.querySelector('.profile-page .pf-hero') && !!document.querySelector('.about-members .member')`, 15000);
const menuItems = () => p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`);
/** Right-click the member row with this name; the menu's items. */
const memberMenu = async (name: string) => {
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.eval(`(() => { const b = [...document.querySelectorAll('.about-members .member')].find((m) => m.querySelector('b')?.textContent.startsWith(${JSON.stringify(name)})); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 })); })()`);
  await p.until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 4000);
  return menuItems();
};

try {
  await p.size(1280, 900);
  // Confirms answer yes; the name typed to end a group is never asked here.
  await p.eval(`window.confirm = () => true`);

  await p.goto(`${hub}/#/about/c/${climb}`);
  await opened();
  await p.until(`!!document.querySelector('.pf-moderation')`, 8000).catch(() => {});
  check(await p.eval(`!!document.querySelector('.pf-moderation')`), 'a group you administer has a Moderation card');
  check(await p.eval(`[...document.querySelectorAll('.pf-card h3')].some((h) => h.textContent.includes('Your label'))`), 'and your own label');
  check(await p.eval(`!!document.querySelector('.pf-action[data-action="picture"]')`), 'and a button to change its picture');
  const items = await memberMenu('Theo');
  check(['Make Admin', 'Remove From Group', 'Ban'].every((x) => items.some((i) => i.startsWith(x))), "a member's menu offers admin, remove and ban", items);
  await p.eval(`window.confirm = () => true; [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim().startsWith('Remove From Group')).click()`);
  await p.until(`![...document.querySelectorAll('.about-members .member b')].some((b) => b.textContent.startsWith('Theo'))`, 6000).catch(() => {});
  check(await p.eval(`![...document.querySelectorAll('.about-members .member b')].some((b) => b.textContent.startsWith('Theo'))`), 'removed, they leave the list');
  // Your label.
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.eval(`(() => { const i = document.querySelector('.mod-label input[aria-label="Your label here"]'); i.value = 'belayer'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(100);
  await p.eval(`document.querySelector('.mod-label .btn.primary').click()`);
  await p.until(`[...document.querySelectorAll('.about-members .member small')].some((s) => s.textContent.includes('belayer'))`, 6000).catch(() => {});
  check(await p.eval(`[...document.querySelectorAll('.about-members .member small')].some((s) => s.textContent.includes('belayer'))`), 'your label saves and shows by your name');

  // A Discord server you run.
  await p.goto(`${hub}/#/about/s/${dither}`);
  await opened();
  await p.until(`!!document.querySelector('.pf-moderation')`, 8000).catch(() => {});
  check(await p.eval(`!!document.querySelector('.pf-moderation')`), 'the server you run has a Moderation card');
  const lev = await memberMenu('Lev');
  check(['Roles', 'Time Out', 'Kick', 'Ban'].every((x) => lev.some((i) => i.startsWith(x))), 'a member below you: roles, timeout, kick, ban', lev);
  const boss = await memberMenu('Quinn');
  check(!boss.some((i) => i.startsWith('Kick')), 'someone as high as you: nothing to do to them', boss);
  // As the other account, which moderates nothing there.
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.eval(`[...document.querySelectorAll('.about-as .chip-btn')].find((b) => !b.classList.contains('on')).click()`);
  await p.until(`!!document.querySelector('.pf-title .about-lock')`, 6000).catch(() => {});
  check(await p.eval(`!document.querySelector('.pf-moderation')`), 'another account that moderates nothing sees no Moderation card');

  // Someone else's message in a channel you moderate.
  await p.goto(`${hub}/#/c/${general}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(500);
  await p.eval(`(() => { const m = [...document.querySelectorAll('.msg')].find((x) => !x.classList.contains('mine') && !x.classList.contains('system')); const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 40, clientY: r.y + 8 })); })()`);
  await p.until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 4000);
  const msgItems = await menuItems();
  check(msgItems.some((i) => i.startsWith('Delete Message (Moderator)')), "someone else's message offers a moderator's delete", msgItems);
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
