/**
 * People links (docs/add.md "Relationships"), end to end against a demo hub in headless Chromium, at a desktop and a
 * phone width: a flagged request's card names the account it came to, shows Discord's warning above the buttons,
 * opens the profile from the avatar, and says what Discord answered when Message is refused; Accept takes a second
 * click there ("Accept anyway"), which confirms; Message on the other opens the DM on that account, whose banner
 * answers it; a request you sent shows on its DM with Cancel; a profile says how each account stands with them and
 * Remove friend asks first; People lists friends and contacts once per person, with a dot for each account and when
 * you last talked, an account menu under "People", Remove per account in the row's menu (right-click, long press), a
 * filter box and the order; and Add friend on someone Discord wants confirmed comes back with "Add anyway".
 *
 *   bun scripts/verify-people-links.ts http://127.0.0.1:8870 [/tmp/shots]
 * It answers and removes things: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8870';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const get = (path: string) => fetch(`${hub}${path}`).then((r) => r.json()) as Promise<any>;
const bootstrap = () => get('/api/bootstrap');
const boot = await bootstrap();
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const DMAIN = 'acc_demo-discord-main';
const DALT = 'acc_demo-discord-alt';
const TG = 'acc_demo-telegram';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const action = (account: string, name: string, args?: unknown) =>
  fetch(`${hub}/api/accounts/${account}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, args }) }).then((r) => r.json()) as Promise<any>;
const answers = async () => (await action(DALT, 'addLog')).result?.answer as number;

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const at = () =>
    p.eval<{ x: number; y: number } | null>(
      `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
    );
  // Where it has come to rest: a phone's sheet slides up for a moment, and a click aimed mid-slide misses.
  let r = await at();
  for (let i = 0; i < 20 && r; i++) {
    await Bun.sleep(60);
    const next = await at();
    if (next && Math.abs(next.x - r.x) < 1 && Math.abs(next.y - r.y) < 1) break;
    r = next;
  }
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
/** The first visible element matching `sel` whose text is `label`. */
const clickText = async (sel: string, label: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && x.innerText.trim() === ${JSON.stringify(label)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} "${label}"`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const centerOf = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const rightClick = async (sel: string) => {
  const r = await centerOf(sel);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0, clickCount: 0 });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', buttons: 0, clickCount: 1 });
  await Bun.sleep(300);
};
const longPress = async (sel: string) => {
  const r = await centerOf(sel);
  await p.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  await Bun.sleep(650);
  await p.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await Bun.sleep(400);
};
const escape = () => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (sel: string) => p.eval<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
/** A fresh page at this route: the same address again reloads, so nothing from before stays open. */
const open = async (h: string, ready: string) => {
  const url = `${hub}/${h}`;
  if ((await p.eval<string>('location.href')) === url) {
    await p.send('Page.reload', {});
    await Bun.sleep(300);
  } else await p.goto(url);
  await p.until(`!!document.querySelector(${JSON.stringify(ready)})`, 20000);
};
const desktop = () => p.size(1280, 820);
const phone = () => p.size(390, 844, true);
/** Nothing wider than the screen. */
const fits = async (what: string) => {
  const f = await p.eval<{ w: number; scroll: number }>(`({ w: innerWidth, scroll: document.documentElement.scrollWidth })`);
  check(f.scroll <= f.w + 1, `${what} fits a phone`, f);
};
/** Into view, for a screenshot. */
const show = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`);

const discord = (handle: string) => boot.identities.find((i: any) => i.network === 'discord' && i.handle === handle);
const drops = discord('free.nitro.drops');
const wren = discord('wren.fm');
const mara = discord('mara');
const ravi = discord('ravi_p');
const theo = discord('theo.k');
const reqOf = (i: any) => boot.requests.find((r: any) => r.from === i?.id);
const dropsReq = reqOf(drops);
const wrenReq = reqOf(wren);
if (!dropsReq?.warning || !wrenReq?.warning || !mara || !ravi?.personId || !theo) throw new Error('the demo world lacks its flagged requests and friends');
const cardOf = (r: any) => `.request-card[data-request="${r.id}"]`;

try {
  await desktop();

  // 1. A flagged request's card: the account it came to, Discord's words above the buttons, and Message.
  await open(`#/requests/${wrenReq.id}`, cardOf(wrenReq));
  const wc = cardOf(wrenReq);
  check((await text(`${wc} .request-to`)) === 'to your Discord account alt', 'the card names the account plainly', await text(`${wc} .request-to`));
  check((await text(`${wc} .request-warning`)).includes('Discord says you share no server or friend with them.'), "and shows Discord's warning", await text(`${wc} .request-warning`));
  const above = await p.eval<boolean>(`document.querySelector(${JSON.stringify(`${wc} .request-warning`)}).getBoundingClientRect().bottom <= document.querySelector(${JSON.stringify(`${wc} .request-actions`)}).getBoundingClientRect().top`);
  check(above, 'above the buttons');
  check((await text(`${wc} [data-answer]`)) === 'Accept | Decline | Block | Message', 'Accept, Decline, Block and Message', await text(`${wc} [data-answer]`));
  await shot('links-01-card-desktop');
  await click(`${wc} .request-avatar`);
  await p.until(`location.hash.startsWith('#/i/') || location.hash.startsWith('#/p/')`, 8000);
  check((await hash()).includes(wren.id), 'the avatar opens their profile', await hash());
  await phone();
  await open(`#/requests/${wrenReq.id}`, cardOf(wrenReq));
  await show(wc);
  await fits('the Requests view');
  await shot('links-01-card-phone');
  await desktop();

  // 2. Message on the spam-flagged one: Discord will not deliver to them, and the card says so.
  await open(`#/requests/${dropsReq.id}`, cardOf(dropsReq));
  const dc = cardOf(dropsReq);
  await click(`${dc} [data-answer="message"]`);
  await p.until(`!!document.querySelector(${JSON.stringify(`${dc} .request-error`)})`, 8000);
  check((await text(`${dc} .request-error`)).includes('Discord will not deliver a message to them'), "a refused Message shows what Discord said", await text(`${dc} .request-error`));
  check((await hash()).startsWith('#/requests'), 'and stays on the card');
  await shot('links-02-refused-desktop');

  // 3. Accept there takes a second click: nothing goes to Discord until "Accept anyway", which confirms.
  const before = await answers();
  await click(`${dc} [data-answer="accept"]`);
  await p.until(`!!document.querySelector(${JSON.stringify(`${dc} [data-confirm="accept"]`)})`, 5000);
  check((await answers()) === before, 'the first Accept asks nothing of Discord');
  const step = await text(`${dc} .add-confirm`);
  check(step.includes('Discord filed this request as possible spam.') && step.includes('Nothing is accepted yet. Accept it anyway, or message them first to see who they are.'), "the step: Discord's words, then what Accept anyway does", step);
  await shot('links-03-confirm-desktop');
  await phone();
  await open(`#/requests/${dropsReq.id}`, cardOf(dropsReq));
  await click(`${dc} [data-answer="accept"]`);
  await p.until(`!!document.querySelector(${JSON.stringify(`${dc} [data-confirm="accept"]`)})`, 5000);
  await show(`${dc} .add-confirm`);
  await fits('the confirm step');
  await shot('links-03-confirm-phone');
  await desktop();
  await open(`#/requests/${dropsReq.id}`, cardOf(dropsReq));
  await click(`${dc} [data-answer="accept"]`);
  await p.until(`!!document.querySelector(${JSON.stringify(`${dc} [data-confirm="accept"]`)})`, 5000);
  await click(`${dc} [data-confirm="accept"]`);
  await p.until(`!document.querySelector(${JSON.stringify(dc)})`, 8000);
  check((await answers()) === before + 1, 'Accept anyway asks Discord once');
  const friendsAlt = await get(`/api/people?relationship=friend&account=${DALT}`);
  check(friendsAlt.links.some((l: any) => l.identityId === drops.id), 'and they are a friend of the alt account now');
  check(!(await bootstrap()).requests.some((r: any) => r.id === dropsReq.id), 'the request is gone');

  // 4. Message on the other: the DM on the alt account opens, its banner answers the request.
  await open(`#/requests/${wrenReq.id}`, cardOf(wrenReq));
  await click(`${wc} [data-answer="message"]`);
  await p.until(`location.hash.includes('/c/') && !!document.querySelector('.link-banner.incoming')`, 8000);
  const wrenConv = (await hash()).split('/c/')[1].split('?')[0];
  const conv = (await bootstrap()).conversations.find((c: any) => c.id === wrenConv);
  check(conv?.shape === 'direct' && conv.vantages.map((v: any) => v.accountId).join() === DALT, 'Message opens a DM on the account the request came to', conv?.vantages);
  const banner = await text('.link-banner');
  check(banner.includes('Wren') && banner.includes('wants to be friends') && banner.includes('to your Discord account alt'), 'the DM says Wren wants to be friends, on alt', banner);
  check((await text('.link-banner [data-answer]')) === 'Accept | Decline | Block', 'with Accept, Decline and Block', await text('.link-banner [data-answer]'));
  check((await text('.link-banner .request-warning')).includes('share no server'), "and Discord's warning", await text('.link-banner .request-warning'));
  await shot('links-04-banner-desktop');
  await phone();
  await open(`#/inbox/c/${wrenConv}`, '.link-banner.incoming');
  await fits('the DM with its banner');
  await shot('links-04-banner-phone');
  await desktop();
  await open(`#/inbox/c/${wrenConv}`, '.link-banner.incoming');
  await click('.link-banner [data-answer="decline"]');
  await p.until(`!document.querySelector('.link-banner')`, 8000);
  check(!(await bootstrap()).requests.some((r: any) => r.id === wrenReq.id), 'Decline from the banner answers it, and the banner goes');

  // 5. A request you sent: its DM says so, with Cancel.
  const opened = await fetch(`${hub}/api/directs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: DALT, peer: mara.nativeId }) }).then((r) => r.json());
  const maraConv = opened.conversation?.id;
  check(opened.conversation?.pending?.incoming === false, 'the DM with someone you asked carries the request', opened.conversation?.pending);
  await open(`#/inbox/c/${maraConv}`, '.link-banner.outgoing');
  check((await text('.link-banner')).includes('Friend request sent') && (await text('.link-banner')).includes('from your Discord account alt') && (await has('.link-banner [data-remove="requested"]')), '"Friend request sent" from alt, with Cancel', await text('.link-banner'));
  await shot('links-05-sent-desktop');
  await phone();
  await open(`#/inbox/c/${maraConv}`, '.link-banner.outgoing');
  await fits('the DM with a request sent');
  await shot('links-05-sent-phone');
  await desktop();
  await open(`#/inbox/c/${maraConv}`, '.link-banner.outgoing');
  await click('.link-banner [data-remove="requested"]');
  await p.until(`!!document.querySelector('[data-remove-dialog="requested"]')`, 5000);
  check((await text('[data-remove-dialog]')).includes('Cancel your friend request to Mara on your Discord account alt?'), 'Cancel asks first', await text('[data-remove-dialog]'));
  await click('[data-confirm-remove="requested"]');
  await p.until(`!document.querySelector('.link-banner')`, 8000);
  check(!(await get(`/api/people?relationship=requested&account=${DALT}`)).links.some((l: any) => l.identityId === mara.id), 'cancelled: the request is off the list, and the banner gone');

  // 6. A profile: how each account stands with them, and Remove friend after a question.
  await open(`#/p/${ravi.personId}`, '.profile-page');
  await p.until(`!!document.querySelector('.pf-standing .pf-link-row') && !document.querySelector('.pf-asking')`, 10000);
  check((await count('.pf-standing .pf-link-row[data-rel="friend"]')) === 2, 'Ravi: a friend of both Discord accounts', await text('.pf-standing'));
  check((await text('.pf-standing [data-remove]')) === 'Remove friend | Remove friend', 'each with Remove friend', await text('.pf-standing [data-remove]'));
  await show('.pf-standing');
  await shot('links-06-profile-desktop');
  await click(`.pf-link-row[data-account="${DMAIN}"] [data-remove="friend"]`);
  await p.until(`!!document.querySelector('[data-remove-dialog="friend"]')`, 5000);
  check((await text('[data-remove-dialog]')).includes('Remove Ravi as a friend on your Discord account main?'), 'Remove friend asks first, naming the account', await text('[data-remove-dialog]'));
  await shot('links-07-remove-desktop');
  await click('[data-confirm-remove="friend"]');
  await p.until(`!document.querySelector('.pf-link-row[data-account="${DMAIN}"]')`, 8000);
  check(!(await get(`/api/people?relationship=friend&account=${DMAIN}`)).links.some((l: any) => l.identityId === ravi.id), 'removed on main');
  check((await count('.pf-standing .pf-link-row')) === 1, 'and still a friend of alt', await text('.pf-standing'));
  await phone();
  await open(`#/p/${ravi.personId}`, '.profile-page');
  await p.until(`!!document.querySelector('.pf-standing .pf-link-row')`, 10000);
  await show('.pf-standing');
  await fits('the profile');
  await shot('links-06-profile-phone');
  await click(`.pf-link-row[data-account="${DALT}"] [data-remove="friend"]`);
  await p.until(`!!document.querySelector('[data-remove-dialog="friend"]')`, 5000);
  await fits('the question');
  await shot('links-07-remove-phone');
  await click('[data-remove-dialog] .btn.ghost');
  await p.until(`!document.querySelector('[data-remove-dialog]')`, 5000);
  check((await get(`/api/people?relationship=friend&account=${DALT}`)).links.some((l: any) => l.identityId === ravi.id), 'Keep keeps it');
  await desktop();

  // 7. People: friends once per person across accounts, a dot for each account, when you last talked; the account
  // menu; Remove in the row's menu, per account; the filter box and the order; contacts.
  await open('#/people', '.people-chips');
  await click('.people-chips [data-filter="friend"]');
  await p.until(`!!document.querySelector('.plink-row')`, 8000);
  const names = await p.eval<string[]>(`[...document.querySelectorAll('.plink-row .row-title')].map((e) => e.textContent.trim())`);
  check(names.includes('Alice Chen') && names.includes('Nitro Drops') && names.includes('Ravi'), 'Friends lists everyone your accounts are friends with', names);
  check(new Set(names).size === names.length, 'each person once', names);
  check(!(await has('.sidebar .side-sub')) && !(await has('.people-accounts')) && !(await has('.plink-end')), 'one row of chips, no subtitle, no × on the rows');
  check((await text('.people-chips')).replace(/\s+/g, ' ') === 'Chats Friends Contacts', 'chips for the lists these accounts keep: no X or Instagram here, so no Following', await text('.people-chips'));
  const theoRow = `.plink-row[data-plink="${theo.id}"]`;
  const raviRow = `.plink-row[data-plink="${ravi.id}"]`;
  const dotsOf = (row: string) => p.eval<string>(`document.querySelector(${JSON.stringify(`${row} .plink-dots`)})?.dataset.accounts ?? ''`);
  check((await dotsOf(theoRow)) === `${DMAIN} ${DALT}`, 'a friend on both Discord accounts: one row, a dot for each', await dotsOf(theoRow));
  check((await p.eval<string>(`document.querySelector(${JSON.stringify(`${theoRow} .plink-dots`)}).title`)) === 'Discord main, Discord alt', 'the dots name the accounts');
  const theoTip = await p.eval<string>(`document.querySelector(${JSON.stringify(theoRow)}).title`);
  check(/^Friends since \w+ \d{4} on Discord main and Discord alt$/.test(theoTip), 'since when moves to the tooltip', theoTip);
  check(/^talked .+/.test(await text(`${raviRow} .plink-talked`)), 'the second line says when you last talked', await text(`${raviRow} .plink-talked`));
  // The account menu, under "People".
  check((await text('.people-acc-btn')).trim() === 'All accounts', 'an account menu under "People"', await text('.people-acc-btn'));
  await click('.people-acc-btn');
  await p.until(`!!document.querySelector('.cm [role="menuitemradio"]')`, 3000);
  const accItems = await p.eval<string[]>(`[...document.querySelectorAll('.cm [role="menuitemradio"]')].map((e) => e.innerText.trim())`);
  check(accItems.join() === 'All accounts,Discord main,Discord alt' && (await count('.cm .cm-dot')) === 3, 'its menu: all accounts and each, each with its colour', accItems);
  await shot('links-08-people-desktop');
  await clickText('.cm [role="menuitemradio"]', 'Discord alt');
  await p.until(`document.querySelector('.people-acc-btn').innerText.includes('Discord alt')`, 3000);
  const altFriends = (await get(`/api/people?relationship=friend&account=${DALT}`)).links.length;
  check((await count('.plink-row')) === altFriends && !(await has('.plink-dots')), 'one account at a time, without dots', { rows: await count('.plink-row'), altFriends });
  await click('.people-acc-btn');
  await p.until(`!!document.querySelector('.cm [role="menuitemradio"]')`, 3000);
  await clickText('.cm [role="menuitemradio"]', 'All accounts');
  await p.until(`!!document.querySelector(${JSON.stringify(`${theoRow} .plink-dots`)})`, 3000);
  // Remove is in the row's menu, one item per account it is on.
  await rightClick(theoRow);
  await p.until(`!!document.querySelector('.cm[role="menu"]')`, 3000);
  const theoMenu = await p.eval<string[]>(`[...document.querySelectorAll('.cm[role="menu"] [role^="menuitem"]')].map((e) => e.innerText.trim())`);
  check(theoMenu.includes('Profile') && theoMenu.includes('Remove friend on Discord main') && theoMenu.includes('Remove friend on Discord alt'), "the row's menu: the person's items and Remove on each account", theoMenu);
  await shot('links-10-row-menu-desktop');
  await clickText('.cm[role="menu"] [role="menuitem"]', 'Remove friend on Discord alt');
  await p.until(`!!document.querySelector('[data-remove-dialog="friend"]')`, 5000);
  check((await text('[data-remove-dialog]')).includes('on your Discord account alt?'), 'it asks first, naming the account', await text('[data-remove-dialog]'));
  await click('[data-confirm-remove="friend"]');
  await p.until(`document.querySelector(${JSON.stringify(`${theoRow} .plink-dots`)})?.dataset.accounts === ${JSON.stringify(DMAIN)}`, 8000);
  check(!(await get(`/api/people?relationship=friend&account=${DALT}`)).links.some((l: any) => l.identityId === theo.id), 'removed on alt; still a friend on main, one row with one dot');
  // The filter box, and the order.
  await p.eval(`document.querySelector('.people-find input').focus()`);
  await p.send('Input.insertText', { text: 'ra' });
  await Bun.sleep(300);
  const found = await p.eval<string[]>(`[...document.querySelectorAll('.plink-row .row-title')].map((e) => e.textContent.trim())`);
  check(found.length > 0 && found.length < names.length && found.every((n) => /ra/i.test(n)) && found.includes('Ravi'), 'the filter box narrows the list by name', found);
  await escape();
  await Bun.sleep(200);
  check((await count('.plink-row')) === names.length, 'Esc empties it');
  const talked = await p.eval<boolean[]>(`[...document.querySelectorAll('.plink-row .plink-talked')].map((e) => !!e.textContent)`);
  check(talked.indexOf(false) === -1 || talked.slice(talked.indexOf(false)).every((x) => !x), 'by default, whom you talked with last first', talked);
  await click('.side-sort');
  await p.until(`!!document.querySelector('.cm [role="menuitemradio"]')`, 3000);
  check((await p.eval<string[]>(`[...document.querySelectorAll('.cm [role="menuitemradio"]')].map((e) => e.innerText.trim())`)).join() === 'Last talked,A to Z', 'the order: Last talked or A to Z');
  await clickText('.cm [role="menuitemradio"]', 'A to Z');
  await Bun.sleep(300);
  const az = await p.eval<string[]>(`[...document.querySelectorAll('.plink-row .row-title')].map((e) => e.textContent.trim())`);
  check(az.join() === [...az].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).join(), 'A to Z', az);
  await click('.side-sort');
  await p.until(`!!document.querySelector('.cm [role="menuitemradio"]')`, 3000);
  await clickText('.cm [role="menuitemradio"]', 'Last talked');
  // Contacts: one Telegram account, so no menu and no dots.
  await click('.people-chips [data-filter="contact"]');
  await p.until(`[...document.querySelectorAll('.plink-row .row-title')].some((e) => e.textContent.includes('Noor'))`, 8000);
  const where = await p.eval<string[]>(`[...document.querySelectorAll('.plink-row')].map((e) => e.title)`);
  check(where.length === 2 && where.every((t) => t.endsWith('on Telegram personal')) && !(await has('.people-acc-btn')) && !(await has('.plink-dots')), 'Contacts: Telegram contacts', { names: await text('.plink-row .row-title'), where });
  // On a phone: the same list, the account menu as a sheet, and a long press for the row's menu.
  await phone();
  await open('#/people', '.people-chips');
  await click('.people-chips [data-filter="friend"]');
  await p.until(`!!document.querySelector('.plink-row')`, 8000);
  await fits('People');
  await shot('links-08-people-phone');
  await click('.people-acc-btn');
  await p.until(`!!document.querySelector('.cm-sheet')`, 3000);
  await shot('links-09-accounts-phone');
  await escape();
  await p.until(`!document.querySelector('.cm-sheet')`, 3000).catch(() => {});
  // Someone still a friend of both accounts (Ravi and Theo are not, by now).
  const both = await p.eval<string>(`[...document.querySelectorAll('.plink-row')].find((e) => e.querySelector('.plink-dots')?.dataset.accounts === ${JSON.stringify(`${DMAIN} ${DALT}`)})?.dataset.plink ?? ''`);
  check(both, 'someone on both accounts');
  await longPress(`.plink-row[data-plink="${both}"]`);
  await p.until(`!!document.querySelector('.cm-sheet')`, 3000);
  const sheet = await p.eval<string[]>(`[...document.querySelectorAll('.cm-sheet .sheet-action')].map((b) => b.innerText.trim())`);
  check(sheet.includes('Remove friend on Discord main') && sheet.includes('Remove friend on Discord alt'), 'a long press opens the menu, with Remove per account', sheet);
  await shot('links-10-row-menu-phone');
  await escape();
  await desktop();
  await open('#/people', '.people-chips');
  await click('.people-chips [data-filter="chats"]');

  // 8. Add friend on a username Discord wants confirmed: its words, then Add anyway.
  await open('#/inbox', '.side-new');
  await click('.side-new');
  await p.until(`!!document.querySelector('.palette-input')`, 3000);
  await p.eval(`document.querySelector('.palette-input').focus()`);
  await p.send('Input.insertText', { text: 'kestrel.dev' });
  await Bun.sleep(200);
  await click('.add-reading[data-network="discord"]');
  await p.until(`!!document.querySelector('.add-card-name') && !document.querySelector('.add-loading')`, 8000);
  await click('.add-actions [data-action="friend"]');
  await p.until(`!!document.querySelector('[data-confirm="add"]')`, 8000);
  check((await text('.add-confirm')).includes('You must confirm the friend request to add this user.') && (await text('.add-confirm')).includes('No friend request has gone out yet.'), "Add friend: Discord's words and Add anyway", await text('.add-confirm'));
  await shot('links-09-add-confirm-desktop');
  await click('[data-confirm="add"]');
  await p.until(`!!document.querySelector('.add-done-line')`, 8000);
  check((await text('.add-done-line')).includes('Asked; waiting on them'), 'Add anyway sends it', await text('.add-done-line'));

  // The refused Message is a 502 from the hub, which the browser logs; nothing else.
  const errors = p.errors.filter((e) => !/status of 502/.test(e));
  check(!errors.length && p.errors.length <= 1, 'no page errors but the refused Message', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
