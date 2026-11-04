/**
 * About and settings (docs/group-settings.md), end to end against a demo hub in headless Chromium: the panel opens
 * from a conversation's header, its menu and a space's header; a Signal group you administer lets you rename it and
 * change its timer, and the change reaches the conversation; a group where only admins edit shows every setting
 * locked with the reason; one Discord server seen through two accounts shows each one's view; pinned messages and
 * members by role; and the same panel as a sheet on a phone.
 *
 *   bun scripts/verify-about.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this renames and changes things.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8497';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const convNamed = (network: string, name: string) => boot.conversations.find((c: any) => c.network === network && c.name === name)?.id;
const climb = convNamed('signal', 'Climbing crew 🧗');
const family = convNamed('signal', 'Family');
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general' && c.vantages.length === 2)?.id;
const dither = boot.spaces.find((s: any) => s.network === 'discord' && s.name === 'libdither')?.id;
if (!climb || !family || !general || !dither) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const about = (kind: 'conversations' | 'spaces', id: string, account?: string) => fetch(`${hub}/api/${kind}/${id}/about${account ? `?account=${account}` : ''}`).then((r) => r.json()) as Promise<any>;

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const opened = () => p.until(`!!document.querySelector('.about .about-section')`, 10000);
const closeDialog = async () => {
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.until(`!document.querySelector('.about')`, 4000);
};
const rows = () =>
  p.eval<{ key: string; editable: boolean; value: string; reason: string }[]>(
    `[...document.querySelectorAll('.about-row')].map((r) => ({ key: r.dataset.key, editable: r.classList.contains('editable'), value: (r.querySelector('select')?.value ?? r.querySelector('input')?.checked ?? r.querySelector('.about-value')?.textContent ?? '') + '', reason: r.querySelector('.about-reason')?.textContent?.trim() ?? '' }))`,
  );

try {
  await p.size(1280, 860);

  // A Signal group you administer, from the header's button.
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await click('.conv-head .hdr-btn[aria-label="About and settings"]');
  await opened();
  const r1 = await rows();
  check(r1.map((r) => r.key).join(',') === 'disappearing,announceOnly,editInfo,addMembers,joinApproval,encrypted', 'Signal’s settings, in its own order', r1.map((r) => r.key));
  check(r1.find((r) => r.key === 'disappearing')?.editable && r1.find((r) => r.key === 'disappearing')?.value === '604800', 'an admin may change the timer, set to a week', r1.find((r) => r.key === 'disappearing'));
  check(r1.find((r) => r.key === 'encrypted')?.reason.includes('Always on'), 'encryption is locked, and says why', r1.find((r) => r.key === 'encrypted'));
  check(r1.find((r) => r.key === 'joinApproval')?.reason.includes('does not say'), 'join approval says Signal does not tell', r1.find((r) => r.key === 'joinApproval'));
  const roles = await p.eval<string[]>(`[...document.querySelectorAll('.about-role h4')].map((h) => h.textContent)`);
  check(roles[0] === 'Admin' && roles.includes('Member'), 'members grouped by role, admins first', roles);
  check(await p.eval(`!!document.querySelector('.about-invite code')?.textContent.includes('signal.group')`), 'the invite link is shown');
  if (shots) await p.shot(`${shots}/about-signal-admin.png`);

  // Change the timer.
  await p.eval(`(() => { const s = document.querySelector('.about-row[data-key="disappearing"] select'); s.value = '86400'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.until(`document.querySelector('.about-row[data-key="disappearing"] select')?.value === '86400'`, 6000);
  check((await about('conversations', climb)).fields.disappearing.value === 86400, 'the timer changed on the network: one day');

  // Rename it, from the pencil.
  await click('.about-head .about-pencil');
  await p.until(`!!document.querySelector('.about-head .about-input')`, 3000);
  await p.eval(`(() => { const i = document.querySelector('.about-head .about-input'); i.value = 'Climbing crew'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(100);
  await p.eval(`document.querySelector('.about-head .about-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await p.until(`document.querySelector('.about-head h2')?.textContent === 'Climbing crew'`, 6000);
  await p.until(`document.querySelector('.conv-head h2')?.textContent.startsWith('Climbing crew') && !document.querySelector('.conv-head h2')?.textContent.includes('🧗')`, 6000).catch(() => {});
  check((await p.eval<string>(`document.querySelector('.conv-head h2')?.textContent ?? ''`)).trim() === 'Climbing crew', 'the new name reaches the conversation’s header', await p.eval(`document.querySelector('.conv-head h2')?.textContent`));
  await closeDialog();

  // A group where only admins edit, from the conversation's menu.
  await p.goto(`${hub}/#/c/${family}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await p.eval(`document.querySelector('.conv-head').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 30 }))`);
  await p.until(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes('About This'))`, 4000);
  await p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('About This')).click()`);
  await opened();
  const r2 = await rows();
  check(r2.length > 0 && r2.every((r) => !r.editable), 'nothing is editable for a member', r2.map((r) => `${r.key}:${r.editable}`));
  check(r2.find((r) => r.key === 'disappearing')?.reason.includes('Only admins'), 'and each says why', r2.find((r) => r.key === 'disappearing')?.reason);
  check(await p.eval(`!document.querySelector('.about-head .about-pencil') && !!document.querySelector('.about-head .about-lock')`), 'the name has a lock, not a pencil');
  if (shots) await p.shot(`${shots}/about-signal-member.png`);
  await closeDialog();

  // One Discord server through two accounts, from the space's header.
  await p.goto(`${hub}/#/s/${dither}`);
  await p.until(`!!document.querySelector('.space-about')`, 10000);
  await click('.space-about');
  await opened();
  const as = await p.eval<number>(`document.querySelectorAll('.about-as .chip-btn').length`);
  check(as === 2, 'a chooser between the two accounts in it', as);
  check(await p.eval(`!!document.querySelector('.about-head .about-pencil')`), 'as its owner the server’s name can change');
  await p.eval(`[...document.querySelectorAll('.about-as .chip-btn')].find((b) => !b.classList.contains('on')).click()`);
  await p.until(`!!document.querySelector('.about-head .about-lock')`, 6000);
  const lock = await p.eval<string>(`document.querySelector('.about-head .about-lock')?.title ?? ''`);
  check(lock.includes('Manage Server'), 'as the other account it is locked: Manage Server', lock);
  const roleNames = await p.eval<string[]>(`[...document.querySelectorAll('.about-role h4')].map((h) => h.textContent)`);
  check(roleNames[0] === 'Maintainer', 'members under their top role', roleNames);
  check((await p.eval<string>(`document.querySelector('.about-members .det-note')?.textContent ?? ''`)).includes('loaded'), 'a lazily loaded member list says so');
  const names = await p.eval<string[]>(`[...document.querySelectorAll('.about-members .member b')].map((b) => b.textContent)`);
  check(names.length > 3 && !names.includes('Unknown'), 'every member has a name, strangers too', names);
  if (shots) await p.shot(`${shots}/about-discord-server.png`);
  await closeDialog();

  // Pinned messages, and going to one.
  await p.goto(`${hub}/#/c/${general}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await click('.conv-head .hdr-btn[aria-label="About and settings"]');
  await opened();
  const pins = await p.eval<string[]>(`[...document.querySelectorAll('.about-pin-open span')].map((s) => s.textContent)`);
  check(pins.length === 1 && pins[0].includes('getting-started'), 'the pinned message is listed', pins);
  const slow = (await rows()).find((r) => r.key === 'slowMode');
  check(slow?.editable && slow.value === '0', 'slow mode, off, may be changed by the owner', slow);
  await click('.about-pin-open');
  await p.until(`!document.querySelector('.about')`, 4000);
  check(await p.until(`location.hash.includes('m=') && !!document.querySelector('.msg.flash')`, 4000).then(() => true, () => false), 'going to a pin opens the conversation at it', await p.eval('location.hash'));

  // The same panel as a sheet on a phone.
  await p.size(390, 820, true);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  // A tap, not a mouse click: the phone layout takes touch.
  await p.eval(`document.querySelector('.conv-head .hdr-btn[aria-label="About and settings"]').click()`);
  await opened();
  await Bun.sleep(700); // the sheet slides up
  const box = await p.eval<{ w: number; bottom: number }>(`(() => { const b = document.querySelector('.modal').getBoundingClientRect(); return { w: Math.round(b.width), bottom: Math.round(innerHeight - b.bottom) }; })()`);
  check(box.w >= 380 && Math.abs(box.bottom) <= 2, 'on a phone it is a sheet along the bottom, full width', box);
  if (shots) await p.shot(`${shots}/about-phone.png`);

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
