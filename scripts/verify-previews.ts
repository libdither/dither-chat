/**
 * Taking link previews off (docs/sending.md "Remove Embeds, Report"), end to end against a demo hub in headless
 * Chromium: someone else's message with embeds in a Discord channel you moderate offers Remove Embeds (Moderator), and
 * the embeds go once it is clicked; your own Discord message offers Remove Embeds; your own Signal message with a link
 * preview offers Remove Link Preview, asks first that it goes as an edit, and comes back edited without it.
 *
 *   bun scripts/verify-previews.ts http://127.0.0.1:8497 [screenshot dir]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this takes previews off. With a screenshot dir, each
 * menu is saved there as it opens, beside the message (menu-moderator.png, menu-own-discord.png, menu-own-signal.png),
 * and the Signal message after (signal-after.png).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general' && c.vantages.length === 2)?.id;
const alice = boot.conversations.find((c: any) => c.network === 'signal' && c.shape === 'direct' && c.lastMessage?.text === 'no rush, just before thursday')?.id;
if (!general || !alice) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const { page: p, close } = await launch();
const menuItems = () => p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`);
/** The message whose text has this in it. */
const find = (text: string) => `[...document.querySelectorAll('.msg')].find((x) => x.textContent.includes(${JSON.stringify(text)}))`;
/** Right-click the message with this text; the menu's items, and a screenshot of it where asked. */
const menuOf = async (text: string, shot?: string) => {
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.until(`!!${find(text)}`, 15000);
  await p.eval(`${find(text)}.scrollIntoView({ block: 'center' })`);
  await Bun.sleep(300);
  await p.eval(`(() => { const m = ${find(text)}; const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + 600, clientY: r.y + 12 })); })()`);
  await p.until(`document.querySelectorAll('[role="menuitem"]').length > 0`, 4000);
  await Bun.sleep(250);
  if (shots && shot) await p.shot(join(shots, shot));
  return menuItems();
};
/** Click the menu's item with this label, where it has one (the checks after say what did not happen). */
const pick = (label: string) => p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`);
const embedsOf = (text: string) => p.eval<number>(`${find(text)}?.querySelectorAll('.embed').length ?? -1`);

try {
  await p.size(1280, 860);
  await p.eval(`window.__asked = []; window.confirm = (q) => (window.__asked.push(q), true)`);

  // Someone else's, where you moderate.
  await p.goto(`${hub}/#/c/${general}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await p.eval(`window.__asked = []; window.confirm = (q) => (window.__asked.push(q), true)`);
  const theirs = 'the long version';
  check((await embedsOf(theirs)) === 1, "someone else's message shows its embed");
  const modItems = await menuOf(theirs, 'menu-moderator.png');
  check(modItems.includes('Remove Embeds (Moderator)'), "someone else's message offers a moderator's Remove Embeds", modItems);
  await pick('Remove Embeds (Moderator)');
  await p.until(`${find(theirs)}?.querySelectorAll('.embed').length === 0`, 6000).catch(() => {});
  check((await embedsOf(theirs)) === 0, 'after a confirm, its embed is gone', await p.eval(`window.__asked`));

  // Your own on Discord: at once, as Discord's own menu does.
  const mine = 'and the simulator';
  const ownItems = await menuOf(mine, 'menu-own-discord.png');
  check(ownItems.includes('Remove Embeds') && !ownItems.includes('Remove Embeds (Moderator)'), 'your own Discord message offers Remove Embeds', ownItems);
  await pick('Remove Embeds');
  await p.until(`${find(mine)}?.querySelectorAll('.embed').length === 0`, 6000).catch(() => {});
  check((await embedsOf(mine)) === 0, 'and its embed is gone');

  // Your own on Signal: an edit, after saying so.
  await p.goto(`${hub}/#/c/${alice}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await p.eval(`window.__asked = []; window.confirm = (q) => (window.__asked.push(q), true)`);
  const sig = 'the gym moved its hours';
  check((await embedsOf(sig)) === 1, 'your Signal message shows its link preview');
  const sigItems = await menuOf(sig, 'menu-own-signal.png');
  check(sigItems.includes('Remove Link Preview'), 'it offers Remove Link Preview', sigItems);
  await pick('Remove Link Preview');
  await p.until(`${find(sig)}?.querySelectorAll('.embed').length === 0`, 6000).catch(() => {});
  const asked = await p.eval<string[]>(`window.__asked`);
  check(asked.some((q) => q.includes('as an edit')), 'it asked first, saying it goes as an edit', asked);
  check((await embedsOf(sig)) === 0, 'the preview is gone');
  check(await p.eval(`/edited/i.test(${find(sig)}?.textContent ?? '')`), 'and the message shows as edited');
  if (shots) await p.shot(join(shots, 'signal-after.png'));
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
