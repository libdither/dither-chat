/**
 * Joining and adding (docs/add.md), end to end against a demo hub in headless Chromium: a Discord invite pasted into
 * the New box resolves at once, previews, and Join lands in the new server; a Matrix #alias joins with Enter; a
 * Telegram @name that is a person opens a DM with Message; Add friend on a Discord username says "Asked"; the captcha
 * invite says the network wants a check, with the live-view button, and that nothing was done; the expired invite
 * shows its sentence and no Join; a network whose account cannot resolve shows the plain line and no button; an
 * invite pasted into Ctrl+K offers Join; the message request stays out of the inbox; and the box on a phone.
 *
 *   bun scripts/verify-add.ts http://127.0.0.1:8800 [/tmp/shots]
 * It joins and adds things in the demo world: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8800';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const key = async (k: string, code: number, modifiers = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, modifiers, windowsVirtualKeyCode: code, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, modifiers, windowsVirtualKeyCode: code });
};
const box = '.new-message input.input';
/** The New box from the sidebar's +, empty. */
const openBox = async () => {
  if (await has('.new-message')) await click('.new-message .modal-head [aria-label="Close"]');
  await p.until(`!document.querySelector('.new-message')`, 3000);
  await click('.side-new');
  await p.until(`!!document.querySelector(${JSON.stringify(box)})`, 3000);
};
/** Paste into the box: a paste event, then the text arriving, as a browser does. */
const paste = async (s: string) => {
  await p.eval(`(() => { const i = document.querySelector(${JSON.stringify(box)}); i.focus(); i.dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); })()`);
  await p.send('Input.insertText', { text: s });
};
const type = async (s: string) => {
  await p.eval(`document.querySelector(${JSON.stringify(box)}).focus()`);
  await p.send('Input.insertText', { text: s });
  await Bun.sleep(150);
};
const card = () => p.until(`!!document.querySelector('.add-card-name, .add-error') && !document.querySelector('.add-loading')`, 8000);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;

try {
  await p.size(1280, 820);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector('.side-new')`, 20000);

  // A message request waits under Requests (slice B), never in the inbox.
  const req = boot.requests?.find((r: any) => r.kind === 'message');
  check(boot.requests?.length === 5, 'the demo sends five requests after connecting', boot.requests?.map((r: any) => r.kind));
  const rows = await p.eval<string[]>(`[...document.querySelectorAll('.sidebar .side-scroll [data-row]')].map((el) => el.dataset.row)`);
  check(req?.target?.id && rows.length > 3 && !rows.includes(req.target.id), 'the message request is not in the inbox', { rows: rows.length });

  // 1. A Discord invite, pasted: it resolves at once.
  await openBox();
  check((await p.eval(`document.querySelector(${JSON.stringify(box)}).placeholder`)) === 'Name, invite link, @username or phone', 'the box asks for a name, invite link, @username or phone');
  await paste('https://discord.gg/pixelart');
  await card();
  const pixel = await text('.add-card');
  check(pixel.includes('Pixel Art Club') && pixel.includes('5,321 members') && pixel.includes('802 online') && pixel.includes('Invited by') && pixel.includes('Invite runs out in'), 'a pasted invite previews: name, counts, inviter, expiry', pixel);
  check(await has('.new-message-from .chip-btn'), 'two Discord accounts can: an account picker');
  await shot('add-01-preview');
  await click('.add-actions [data-action="join"]');
  await p.until(`!document.querySelector('.new-message')`, 8000);
  await Bun.sleep(400);
  const space = (await bootstrap()).spaces.find((s: any) => s.name === 'Pixel Art Club');
  check(space && (await hash()).startsWith(`#/s/${space.id}`), 'Join lands in the new server', await hash());
  await shot('add-02-joined');

  // 2. A Matrix address, typed, then Enter.
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await p.until(`!!document.querySelector('.switcher-row')`, 3000);
  const entries = await p.eval<string[]>(`[...document.querySelectorAll('.switcher-row')].map((r) => r.dataset.key)`);
  await p.send('Input.insertText', { text: 'join a server' });
  await Bun.sleep(200);
  const top = await p.eval<string>(`document.querySelector('.switcher-row')?.dataset.key ?? ''`);
  check(top === 'a:join', 'Ctrl+K has "Join a server or group"', { top, entries: entries.length });
  await key('Enter', 13);
  await p.until(`!!document.querySelector(${JSON.stringify(box)})`, 3000);
  check((await text('.new-message h2')) === 'Join a server or group', 'and it opens the same box');
  await type('#rust-gamedev:matrix.org');
  check((await text('.add-reading')).includes('Matrix address #rust-gamedev:matrix.org'), 'the reading says what it is');
  await key('Enter', 13);
  await card();
  check((await text('.add-card')).includes('Rust Gamedev'), 'Enter resolves an address');
  await click('.add-actions [data-action="join"]');
  await p.until(`!document.querySelector('.new-message')`, 8000);
  await Bun.sleep(400);
  const room = (await bootstrap()).conversations.find((c: any) => c.name === 'Rust Gamedev');
  check(room && (await hash()).includes(room.id), 'Join lands in the room', await hash());

  // 3. A Telegram @name that is a person: only a click resolves it, then Message opens a DM.
  await openBox();
  await type('@lena_k');
  await Bun.sleep(400);
  check(!(await has('.add-card')), 'an @name is not looked up as you type');
  check((await text('.add-reading')).includes('Telegram @lena_k'), 'it is offered as a Telegram reading', await text('.add-reading'));
  await click('.add-reading[data-network="telegram"]');
  await card();
  const lena = await text('.add-card');
  check(lena.includes('Lena K') && lena.includes('Person on Telegram') && (await has('[data-action="contact"]')), 'it is a person, with Message and Add contact', lena);
  await click('.add-actions [data-action="message"]');
  await p.until(`!document.querySelector('.new-message')`, 8000);
  await Bun.sleep(400);
  const after = await bootstrap();
  const lenaId = after.identities.find((i: any) => i.network === 'telegram' && i.handle === '@lena_k')?.id;
  const dm = after.conversations.find((c: any) => c.network === 'telegram' && c.shape === 'direct' && c.participantIds.includes(lenaId));
  check(dm && (await hash()).includes(dm.id), 'Message opens a DM with them', { hash: await hash(), dm: dm?.id });

  // 4. Add friend on a Discord username: a partial preview, then "Asked".
  await openBox();
  await type('mara');
  await click('.add-reading[data-network="discord"]');
  await card();
  check((await text('.add-partial')).includes("Can't preview this without asking"), 'a username is a partial preview, said plainly');
  await click('.add-actions [data-action="friend"]');
  await p.until(`!!document.querySelector('.add-done')`, 8000);
  check((await text('.add-done-line')).includes('Asked; waiting on them'), 'Add friend: asked, waiting on them', await text('.add-done'));
  await shot('add-03-asked');

  // 5. The captcha invite: a check, never an error, and nothing done.
  await openBox();
  await paste('discord.gg/speedrun');
  await card();
  await click('.add-actions [data-action="join"]');
  await p.until(`!!document.querySelector('.add-check')`, 8000);
  const chk = await text('.add-check');
  check(chk.includes('Discord wants a check first') && chk.includes('captcha') && chk.includes('Nothing was done') && (await has('.add-check .add-live')), 'the captcha invite: a check first, with the live-view button, nothing done', chk);
  check(!(await bootstrap()).spaces.some((s: any) => s.name === 'Speedrun Archive'), 'and nothing was joined');
  await shot('add-04-check');

  // 6. The expired invite: its sentence, and no Join.
  await openBox();
  await paste('discord.gg/oldparty');
  await card();
  check((await text('.add-error')).includes('This invite has expired or was revoked') && !(await has('[data-action="join"]')), 'the expired invite: its note and no Join', await text('.add-error'));

  // 7. A network whose accounts cannot resolve: the plain line, no button.
  const wa = boot.accounts.find((a: any) => a.network === 'whatsapp');
  await fetch(`${hub}/api/accounts/${wa.id}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'capabilities', args: { without: ['resolve'] } }) });
  await Bun.sleep(600);
  await openBox();
  await paste('https://chat.whatsapp.com/MapleGardenSwap26');
  await Bun.sleep(400);
  check((await text('.add-unbuilt')).includes("Joining from WhatsApp invites isn't built for this account yet") && !(await has('.add-reading')) && !(await has('.add-card')), 'an account without resolve: the plain line, no button', await text('.new-message-list'));
  await shot('add-05-unbuilt');
  await fetch(`${hub}/api/accounts/${wa.id}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'capabilities', args: {} }) });

  // 8. An invite pasted into Ctrl+K offers Join, which opens the box on it.
  await click('.new-message .modal-head [aria-label="Close"]');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await p.until(`!!document.querySelector('.switcher-row')`, 3000);
  await p.eval(`document.querySelector('.switcher-input').focus()`);
  await p.send('Input.insertText', { text: 'discord.gg/libdither' });
  await Bun.sleep(200);
  const first = await p.eval<{ key: string; label: string }>(`(() => { const r = document.querySelector('.switcher-row'); return { key: r.dataset.key, label: r.querySelector('.switcher-label').textContent }; })()`);
  check(first.key === 'join' && first.label === 'Join Discord invite discord.gg/libdither', 'an invite in Ctrl+K offers Join first', first);
  await key('Enter', 13);
  await card();
  check((await text('.add-card')).includes('You are in this server already') && (await has('.add-actions .btn')) && !(await has('[data-action="join"]')), 'and the box opens on it: in already, Open', await text('.add-card'));

  // 9. On a phone: a sheet.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector('.side-new')`, 20000);
  await openBox();
  await paste('https://t.me/+FilmSwap2026x');
  await card();
  const fit = await p.eval<{ w: number; right: number; scroll: number }>(`(() => { const m = document.querySelector('.new-message').getBoundingClientRect(); return { w: m.width, right: m.right, scroll: document.documentElement.scrollWidth }; })()`);
  check((await text('.add-card')).includes('Film Photo Swap') && fit.right <= 391 && fit.scroll <= 391, 'on a phone the box is a sheet that fits, with the preview', fit);
  await shot('add-06-phone');

  // The expired invite's answer is a 502 with the network's sentence, which the browser logs as a failed load.
  const errors = p.errors.filter((e) => !/status of 502/.test(e));
  check(!errors.length && p.errors.length - errors.length === 1, 'no page errors but the expired invite\'s 502', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
