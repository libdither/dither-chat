/**
 * Adding people to groups (docs/group-settings.md, "Adding people"), end to end against a demo hub in headless
 * Chromium: a Signal group you administer has Add people on its page, the picker offers people the account knows and
 * not the ones in it, adding two puts one in and one in as invited, and the members list shows the new one; a Signal
 * group where only admins add says why, with no button; a Discord group DM offers only friends and says how many fit;
 * a Matrix room invites; a WhatsApp group says why it is left out; and the picker on a phone.
 *
 *   bun scripts/verify-add-members.ts http://127.0.0.1:8497 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this adds people.
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
const raid = convNamed('discord', 'weekend raid');
const house = convNamed('matrix', 'Housemates');
const books = convNamed('whatsapp', 'Book club 📚');
if (!climb || !family || !raid || !house || !books) throw new Error('the demo world lacks a place this checks');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}${text ? ` with ${text}` : ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const nameOf = (id: string) => boot.conversations.find((c: any) => c.id === id)?.name as string;
// A hash change keeps the page: wait for this place's own title, not the last one's members card.
const openPage = async (id: string) => {
  await p.goto(`${hub}/#/about/c/${id}`);
  await p.until(
    `document.querySelector('.profile-page .pf-title h2')?.textContent === ${JSON.stringify(nameOf(id))} && !!document.querySelector('.about-members') && ![...document.querySelectorAll('.profile-page .pf-empty')].some((e) => e.textContent.startsWith('Asking'))`,
    15000,
  );
};
const members = () => p.eval<string[]>(`[...document.querySelectorAll('.about-members .member b')].map((b) => b.textContent.replace(' (you)', ''))`);
const rows = () => p.eval<{ name: string; sub: string; on: boolean; disabled: boolean }[]>(`[...document.querySelectorAll('.add-mem .fwd-row')].map((r) => ({ name: r.querySelector('b').textContent, sub: r.querySelector('small').textContent, on: r.classList.contains('on'), disabled: r.disabled }))`);
const sub = () => p.eval<string>(`document.querySelector('.add-mem .fwd-sub')?.textContent ?? ''`);
const dialogOpen = () => p.until(`!!document.querySelector('.add-mem .fwd-row') || !!document.querySelector('.add-mem .fwd-empty')`, 10000);

try {
  await p.size(1280, 860);

  // A Signal group you administer.
  await openPage(climb);
  check(await p.eval(`!!document.querySelector('.about-members .about-add-people')`), 'Signal: the members card has Add people');
  check(await p.eval(`[...document.querySelectorAll('.pf-hero button')].some((b) => b.textContent.includes('Add people'))`), 'and so does the page’s row of actions');
  const before = await members();
  await click('.about-members .about-add-people');
  await dialogOpen();
  const offered = (await rows()).map((r) => r.name);
  check(offered.includes('Quinn') && offered.includes('Dad'), 'the picker offers people the account knows', offered);
  check(!offered.some((n) => before.includes(n)), 'and none who are in it', { offered, before });
  check(!offered.includes('Jamie'), 'nor Jamie, whose message request still waits', offered);
  check((await sub()).includes('privacy settings'), 'it says the network may still refuse someone', await sub());
  if (shots) await p.shot(`${shots}/add-signal-picker.png`);
  // Search narrows it.
  await p.eval(`(() => { const i = document.querySelector('.add-mem .palette-input'); i.value = 'qui'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`document.querySelectorAll('.add-mem .fwd-row').length === 1`, 3000);
  await click('.add-mem .fwd-row', 'Quinn');
  await p.eval(`(() => { const i = document.querySelector('.add-mem .palette-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`document.querySelectorAll('.add-mem .fwd-row').length > 1`, 3000);
  await click('.add-mem .fwd-row', 'Dad');
  check((await p.eval<string[]>(`[...document.querySelectorAll('.add-mem .fwd-chip')].map((c) => c.textContent)`)).length === 2, 'two picked, as chips');
  check((await p.eval<string>(`document.querySelector('.add-mem-send .btn').textContent`)).includes('Add (2)'), 'the button says how many', await p.eval(`document.querySelector('.add-mem-send .btn').textContent`));
  await click('.add-mem-send .btn');
  await p.until(`!document.querySelector('.add-mem')`, 10000);
  await Bun.sleep(400);
  await p.until(`!!document.querySelector('.toast')`, 4000).catch(() => {});
  const toastText = await p.eval<string>(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
  check(String(toastText).includes('Added Quinn') && String(toastText).includes('Invited Dad'), 'it says who was added and who was invited', toastText);
  await p.until(`[...document.querySelectorAll('.about-members .member b')].some((b) => b.textContent === 'Quinn')`, 6000).catch(() => {});
  check((await members()).includes('Quinn'), 'the new member is listed', await members());
  check(await p.until(`[...document.querySelectorAll('.pf-kind')].some((e) => /6 members/.test(e.textContent))`, 4000).then(() => true, () => false), 'and counted', await p.eval(`document.querySelector('.pf-kind')?.textContent`));

  // A group where only admins add.
  await openPage(family);
  check(await p.eval(`!document.querySelector('.about-members .about-add-people')`), 'Signal, not an admin: no Add people');
  check((await p.eval<string>(`document.querySelector('.about-members .about-reason')?.textContent ?? ''`)).includes('Only admins can add members'), 'and it says why', await p.eval(`document.querySelector('.about-members .about-reason')?.textContent`));

  // A Discord group DM: only friends.
  await openPage(raid);
  await click('.about-members .about-add-people');
  await dialogOpen();
  const friends = await rows();
  check(friends.length > 0 && friends.every((r) => r.sub.includes('Friend')), 'Discord: only friends are offered', friends);
  check(!friends.some((r) => r.name === 'Mara'), 'not someone who is not a friend', friends.map((r) => r.name));
  check((await sub()).includes('Only your Discord friends') && (await sub()).includes('7 more fit'), 'it says only friends, and how many more fit', await sub());
  if (shots) await p.shot(`${shots}/add-discord-picker.png`);
  await click('.add-mem-send .btn').catch(() => {});
  check(await p.eval(`document.querySelector('.add-mem-send .btn').disabled`), 'nothing picked: the button does nothing');
  await p.eval(`document.querySelector('.palette-close').click()`);
  await Bun.sleep(400); // a closed dialog steps history back (phone.ts layers): let it before going elsewhere

  // A Matrix room invites.
  await openPage(house);
  check(await p.eval(`document.querySelector('.about-members .about-add-people')?.textContent.includes('Invite people')`), 'Matrix: Invite people');
  await click('.about-members .about-add-people');
  await dialogOpen();
  check((await sub()).includes('in once they accept'), 'it says they are in once they accept', await sub());
  await click('.add-mem .fwd-row', 'kai');
  check((await p.eval<string>(`document.querySelector('.add-mem-send .btn').textContent`)).includes('Invite'), 'the button says Invite');
  await click('.add-mem-send .btn');
  await p.until(`!document.querySelector('.add-mem')`, 10000);
  await Bun.sleep(400);
  check(!(await members()).includes('kai'), 'an invite is not a member yet', await members());

  // WhatsApp: left out on purpose.
  await openPage(books);
  check(await p.eval(`!document.querySelector('.about-members .about-add-people')`), 'WhatsApp: no Add people');
  check((await p.eval<string>(`document.querySelector('.about-members .about-reason')?.textContent ?? ''`)).includes('left out on WhatsApp'), 'and it says why', await p.eval(`document.querySelector('.about-members .about-reason')?.textContent`));

  // On a phone.
  await p.size(390, 820, true);
  await openPage(climb);
  await p.eval(`document.querySelector('.about-members .about-add-people').click()`);
  await dialogOpen();
  await Bun.sleep(400);
  const box = await p.eval<{ w: number; overflow: boolean }>(`(() => { const m = document.querySelector('.palette'); const b = m.getBoundingClientRect(); return { w: Math.round(b.width), overflow: document.documentElement.scrollWidth > innerWidth || m.scrollWidth > m.clientWidth + 1 }; })()`);
  check(box.w >= 360 && !box.overflow, 'on a phone the picker is full width, with nothing sideways', box);
  if (shots) await p.shot(`${shots}/add-phone.png`);

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
