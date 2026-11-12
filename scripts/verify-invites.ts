/**
 * Invites in messages (docs/add.md), end to end against a demo hub in headless Chromium: invite links in messages get
 * cards that say what they are before anything is looked up, and nothing is looked up until Preview is clicked; Preview
 * shows the server; the expired invite shows its sentence; a reload shows the kept preview without asking the network
 * again (the demo adapter's own count); Join lands in the new server and the card then says Joined; a click on the
 * link itself opens the New box on it, and its menu still opens it in the browser; a Matrix room by matrix.to link; a
 * network whose account cannot look invites up shows the plain line and no button; and a card on a phone.
 *
 *   bun scripts/verify-invites.ts http://127.0.0.1:8820 [/tmp/shots]
 * It posts messages and joins things in the demo world: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8820';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
const boot = await bootstrap();
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';
const MX = 'acc_demo-matrix';
const WA = 'acc_demo-whatsapp';
const TG = 'acc_demo-telegram';
const action = (account: string, name: string, args?: unknown) =>
  fetch(`${hub}/api/accounts/${account}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args }) }).then((r) => r.json()) as Promise<any>;
/** Lookups the demo adapters were asked for: a kept preview is none. */
const looks = async (...accounts: string[]) => (await Promise.all(accounts.map((a) => action(a, 'addLog')))).reduce((n, r) => n + r.result.resolve, 0);

// Someone posts the links, as the demo's live messages do.
const selves = new Set(boot.accounts.map((a: any) => a.selfIdentityId));
const someone = (network: string, conv: any) => boot.identities.find((i: any) => i.network === network && !selves.has(i.id) && (!conv.participantIds.length || conv.participantIds.includes(i.id))) ?? boot.identities.find((i: any) => i.network === network && !selves.has(i.id));
const libdither = boot.spaces.find((s: any) => s.network === 'discord' && s.name === 'libdither');
// libdither's #general: both Discord accounts are in it.
const general = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'general' && c.vantages.length === 2);
const room = boot.conversations.find((c: any) => c.network === 'matrix' && c.name === 'libdither');
const book = boot.conversations.find((c: any) => c.network === 'whatsapp' && c.shape === 'group');
const noor = boot.conversations.find((c: any) => c.network === 'telegram' && c.lastMessage?.text?.includes('t.me/dithernews'));
const say = (account: string, conv: any, body: string) => action(account, 'say', { conversation: conv.nativeId, author: someone(conv.network, conv).nativeId, body });
await say(MAIN, general, 'new art server: https://discord.gg/pixelart and the old party one discord.gg/oldparty is gone');
await say(MX, room, 'the gamedev room is https://matrix.to/#/#rust-gamedev:matrix.org?via=matrix.org');
await action(WA, 'capabilities', { without: ['resolve'] });
await say(WA, book, 'garden swap group: https://chat.whatsapp.com/MapleGardenSwap26');
await Bun.sleep(500);

const { page: p, close } = await launch();
const at = (sel: string) =>
  p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }; })()`,
  );
const click = async (sel: string, button: 'left' | 'right' = 'left') => {
  const r = await at(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button, clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
/** The text as written, not as styled (the kind line is in capitals). */
const words = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (sel: string) => p.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const card = (url: string) => `.invite-card[data-url="${url}"]`;
const PIXEL = card('https://discord.gg/pixelart');
const OLD = card('https://discord.gg/oldparty');
const settled = (sel: string) => p.until(`!!document.querySelector(${JSON.stringify(`${sel} .add-card-name, ${sel} .add-error`)}) && !document.querySelector(${JSON.stringify(`${sel} .add-loading`)})`, 8000);
/** `reload`: a new page, which knows nothing the last one looked up. */
const openConv = async (href: string, reload = false) => {
  if (reload) await p.goto('about:blank');
  await p.goto(`${hub}/${href}`);
  await p.until(`document.querySelectorAll('.msg .msg-body').length > 0`, 20000);
  await Bun.sleep(300);
};

try {
  await p.size(1280, 820);

  // 1. Cards say what they are, and nothing is looked up.
  await openConv(`#/s/${libdither.id}/c/${general.id}`);
  await p.until(`document.querySelectorAll('.invite-card[data-network="discord"]').length >= 2`, 8000);
  check((await words(`${PIXEL} .invite-kind`)) === 'Discord server invite' && (await text(`${PIXEL} .invite-url`)) === 'discord.gg/pixelart', 'an invite in a message gets a card: Discord server invite', await text(PIXEL));
  check((await has(`${PIXEL} .invite-preview`)) && (await has(`${OLD} .invite-preview`)) && !(await has('.invite-card .add-card-name')), 'with Preview, and nothing shown that would need a lookup');
  await Bun.sleep(500);
  check((await looks(MAIN, ALT)) === 0, 'nothing was looked up while the cards were drawn', await looks(MAIN, ALT));
  await shot('invites-01-cards');

  // 2. Preview: the server, its counts, Join.
  await click(`${PIXEL} .invite-preview`);
  await settled(PIXEL);
  const pixel = await text(PIXEL);
  check(pixel.includes('Pixel Art Club') && pixel.includes('5,321 members') && pixel.includes('802 online') && (await has(`${PIXEL} [data-action="join"]`)), 'Preview shows the server, its counts and Join', pixel);
  check((await looks(MAIN, ALT)) === 1, 'one lookup, from the click', await looks(MAIN, ALT));
  await shot('invites-02-preview');

  // 3. The expired invite: its sentence, no Join.
  await click(`${OLD} .invite-preview`);
  await settled(OLD);
  check((await text(`${OLD} .add-error`)).includes('This invite has expired or was revoked') && !(await has(`${OLD} [data-action="join"]`)), "the expired invite: the network's sentence, no Join", await text(OLD));

  // 4. A reload shows the kept preview without asking again.
  const before = await looks(MAIN, ALT);
  await openConv(`#/s/${libdither.id}/c/${general.id}`, true);
  await p.until(`!!document.querySelector(${JSON.stringify(`${PIXEL} .add-card-name`)})`, 8000).catch(() => {});
  check((await text(`${PIXEL} .add-card-name`)) === 'Pixel Art Club' && (await has(`${OLD} .invite-preview`)), 'after a reload the preview is there by itself; the expired one asks again', await text('.invite-card'));
  await Bun.sleep(400);
  check((await looks(MAIN, ALT)) === before, 'and the network was not asked again', { before, after: await looks(MAIN, ALT) });

  // 5. Join lands in the new server; back in the chat the card says Joined, with Open.
  await click(`${PIXEL} [data-action="join"]`);
  await p.until(`location.hash.startsWith('#/s/') && !location.hash.includes(${JSON.stringify(libdither.id)})`, 8000).catch(() => {});
  await Bun.sleep(300);
  const pixelSpace = (await bootstrap()).spaces.find((s: any) => s.name === 'Pixel Art Club');
  check(pixelSpace && (await hash()).startsWith(`#/s/${pixelSpace.id}`), 'Join lands in the new server', await hash());
  await openConv(`#/s/${libdither.id}/c/${general.id}`);
  await p.until(`!!document.querySelector(${JSON.stringify(`${PIXEL} .invite-joined`)})`, 8000).catch(() => {});
  check((await has(`${PIXEL} .invite-joined`)) && !(await has(`${PIXEL} [data-action="join"]`)) && (await text(`${PIXEL} .add-actions`)).includes('Open'), 'the card now says Joined, with Open and no Join', await text(PIXEL));
  await shot('invites-03-joined');
  await click(`${PIXEL} .add-actions .btn`);
  await Bun.sleep(400);
  check((await hash()).startsWith(`#/s/${pixelSpace?.id}`), 'and Open goes there', await hash());

  // 6. A click on the link itself opens the New box on it; the cards there knew it before.
  await openConv(`#/inbox/c/${noor.id}`);
  const FILM = card('https://t.me/+FilmSwap2026x');
  await p.until(`!!document.querySelector(${JSON.stringify(FILM)})`, 8000);
  check((await words(`${FILM} .invite-kind`)) === 'Telegram group invite' && (await words(`${card('https://t.me/dithernews')} .invite-kind`)) === 'Telegram channel, group or person', 'Telegram links without https:// get cards too: an invite, a name', await words('.invite-card .invite-kind'));
  const tgBefore = await looks(TG);
  const where = await hash();
  await click('.msg-body a[href="https://t.me/+FilmSwap2026x"]');
  await p.until(`!!document.querySelector('.palette')`, 4000).catch(() => {});
  await p.until(`!!document.querySelector('.new-message .add-card-name, .new-message .add-error') && !document.querySelector('.new-message .add-loading')`, 8000).catch(() => {});
  check((await text('.new-message .add-card-name')) === 'Film Photo Swap' && (await hash()) === where, 'a click on the link opens the New box on it, previewed, and the page stays', { name: await text('.new-message .add-card-name'), hash: await hash() });
  check((await looks(TG)) === tgBefore + 1, 'one lookup, from the click', await looks(TG));
  await shot('invites-04-newbox');
  await click('.palette-close');
  await p.until(`!!document.querySelector(${JSON.stringify(`${FILM} .add-card-name`)})`, 4000).catch(() => {});
  check((await text(`${FILM} .add-card-name`)) === 'Film Photo Swap' && (await looks(TG)) === tgBefore + 1, 'closed, the card under the message shows what the box found, without asking again', await text(FILM));

  // 7. Its menu still opens it in the browser.
  await click('.msg-body a[href="https://t.me/+FilmSwap2026x"]', 'right');
  await p.until(`!!document.querySelector('.cm .cm-item')`, 3000).catch(() => {});
  const items = await p.eval<string[]>(`[...document.querySelectorAll('.cm:last-of-type .cm-item .cm-text')].map((e) => e.textContent)`);
  check(items.includes('Open in Browser') && items.includes('Preview Invite') && items.includes('Copy Link'), 'the link menu: Preview Invite, Open in Browser, Copy Link', items.slice(0, 4));
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  // Closing a menu steps back over the history entry it made: let that land before going on.
  await p.until(`!document.querySelector('.cm')`, 3000).catch(() => {});
  await Bun.sleep(400);

  // 8. A Matrix room by matrix.to link.
  await openConv(`#/inbox/c/${room.id}`);
  const RUST = card('https://matrix.to/#/#rust-gamedev:matrix.org?via=matrix.org');
  await p.until(`!!document.querySelector(${JSON.stringify(RUST)})`, 8000);
  check((await words(`${RUST} .invite-kind`)) === 'Matrix room', 'a matrix.to room link: Matrix room', await text(RUST));
  await click(`${RUST} .invite-preview`);
  await settled(RUST);
  check((await text(`${RUST} .add-card-name`)) === 'Rust Gamedev' && (await has(`${RUST} [data-action="join"]`)), 'Preview: Rust Gamedev, with Join', await text(RUST));

  // 9. An account that cannot look invites up: the plain line, no button.
  await openConv(`#/inbox/c/${book.id}`);
  const GARDEN = card('https://chat.whatsapp.com/MapleGardenSwap26');
  await p.until(`!!document.querySelector(${JSON.stringify(GARDEN)})`, 8000);
  check((await text(`${GARDEN} .invite-unbuilt`)) === "Joining from WhatsApp invites isn't built for this account yet" && (await count(`${GARDEN} button`)) === 0, 'no account can look it up: the plain line and no button', await text(GARDEN));
  await shot('invites-05-unbuilt');
  await action(WA, 'capabilities', {});

  // 10. On a phone.
  await p.size(390, 844, true);
  await openConv(`#/s/${libdither.id}/c/${general.id}`);
  await p.until(`!!document.querySelector(${JSON.stringify(OLD)})`, 8000);
  const fit = await p.eval<{ right: number; scroll: number; cards: number }>(
    `(() => { const cs = [...document.querySelectorAll('.invite-card')]; return { right: Math.max(...cs.map((c) => c.getBoundingClientRect().right)), scroll: document.documentElement.scrollWidth, cards: cs.length }; })()`,
  );
  check(fit.cards >= 2 && fit.right <= 390 && fit.scroll <= 391, 'on a phone the cards fit', fit);
  await at(PIXEL);
  await shot('invites-06-phone');

  // The expired invite's answer is a 502 with the network's sentence, which the browser logs as a failed load.
  const errors = p.errors.filter((e) => !/status of 502/.test(e));
  check(!errors.length, 'no page errors but the expired invite\'s 502', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
