/**
 * The chat header (docs/chats.md, The page), end to end against a multiaccount demo hub in headless Chromium: the line
 * under the name says where your message goes in the same words for a one-route DM and a person's chat (your account
 * as one chip with the network's icon in it), with no "Direct messages › Name" crumb; a server channel keeps its
 * server and section but not the network's name or its own; a group says how many people, not "Groups"; the
 * title starts where the line under it does; the picture's badge is
 * the network you send on; a chat of several routes has a switch row under the head (All, then each network with its
 * glyph and unread): a network's tab shows only that network's routes, interleaved, and sends through it, All brings
 * everything back and keeps the send route, switching the route in the message box moves the tab, Ctrl+Shift+] and [
 * move along the row while the message box keeps its focus and text, and a tab counts what is unread there; a person
 * with mail and Signal shows both under All and each alone, and an email route chosen survives a reload; the line
 * under the name opens the route list, a card (the person, counts, All, routes by network, sending, the profile
 * link), `only this ✕` while one route is shown, with its network's tab chosen; picking a row by click, by
 * press-and-drag and by the keyboard; a message sent while filtered lands on the picked route; a phone of 390 (the
 * row scrolls sideways, and a drag on it is never a swipe back) and the light theme; and no page errors.
 *
 *   DITHER_DEMO_SCENARIO=multiaccount bun packages/hub/src/main.ts --demo --data /tmp/x --port 8577 --web <dist>
 *   bun scripts/verify-chat-header.ts http://127.0.0.1:8577 [/tmp/shots] [--before]
 *
 * `--before` takes the same pictures of an older build (main) without checking anything, named `before-*.png`.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const before = process.argv.includes('--before');
const hub = args[0] ?? 'http://127.0.0.1:8577';
const shots = args[1];
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (name: string) => shots && (await p.shot(`${shots}/${before ? 'before-' : ''}${name}.png`));

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const directs = (pid: string) => boot.conversations.filter((c: any) => c.shape === 'direct' && c.peerPersonId === pid);
const person = (name: string, routes: number) => {
  const x = boot.persons.find((q: any) => q.name === name && directs(q.id).length === routes);
  if (!x) throw new Error(`no ${name} with ${routes} routes: start the hub with DITHER_DEMO_SCENARIO=multiaccount`);
  return x;
};
const jordan = person('Jordan', 1);
const sam = person('Sam Rivera', 2);
const mo = person('Mo', 2);
const kit = person('Kit', 8);
const channel = boot.conversations.find((c: any) => c.shape === 'channel' && c.spaceIds?.length && c.name === 'rules') ?? boot.conversations.find((c: any) => c.shape === 'channel' && c.spaceIds?.length);
const group = boot.conversations.find((c: any) => c.shape === 'group' && c.participantIds?.length > 1);
const netName: Record<string, string> = { discord: 'Discord', signal: 'Signal', matrix: 'Matrix', telegram: 'Telegram', whatsapp: 'WhatsApp' };

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  if (before) return;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const at = async (sel: string, pick = '') => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && x.innerText.includes(${JSON.stringify(pick)})); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${pick}`);
  return r;
};
const mouse = (type: string, x: number, y: number, buttons = 1) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
const click = async (sel: string, pick = '') => {
  const r = await at(sel, pick);
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y, 0);
  await Bun.sleep(150);
};
const key = async (k: string, code = k) => {
  const vk: Record<string, number> = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  // Enter carries its text, so a focused button is pressed by it as by a real key.
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk[k] ?? 0, ...(k === 'Enter' ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk[k] ?? 0 });
  await Bun.sleep(120);
};
const text = (sel: string) => p.eval<string>(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\s+/g, ' ').trim()`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
/** The network the line's first chip stands for: its icon's label (the chip shows the account's name, not the network's). */
const lineNet = (sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.querySelector('.acc-chip.with-net svg')?.getAttribute('aria-label') ?? ''`);
/** Where the title's text starts and where the line under it does. */
const starts = () => p.eval<{ name: number; line: number }>(`(() => { const n = document.querySelector('.conv-head-text h2 > :first-child'); const l = document.querySelector('.conv-head-sub > :first-child'); const x = (e) => Math.round(e.getBoundingClientRect().left + parseFloat(getComputedStyle(e).paddingLeft)); return { name: x(n), line: x(l) }; })()`);
const badge = () => p.eval<string>(`document.querySelector('.conv-head .conv-head-who .avatar-net')?.getAttribute('title') ?? ''`);
const open = async (hash: string) => {
  await p.goto(`${hub}/${hash}`);
  await p.until(`document.querySelectorAll('.msg').length > 1 && !!document.querySelector('.conv-head')`, 15000);
  await Bun.sleep(400);
};
/** The theme, then a fresh load of `hash` with it. */
const theme = async (name: string, hash: string) => {
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
  await p.eval(`(location.hash = ${JSON.stringify(hash)}, location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(300);
};
const openList = async () => {
  await click('.pair-dd-btn');
  await p.until(`!!document.querySelector('.pair-card, .pair-dd-menu')`, 3000);
  await Bun.sleep(150);
};
const card = () =>
  p.eval<{ who: string; all: boolean; heads: string[]; rows: { id: string; text: string; on: boolean; sending: boolean; net: string; ago: string }[]; foot: string; box: { left: number; right: number; bottom: number } }>(`(() => {
    const c = document.querySelector('.pair-card');
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return {
      who: c.querySelector('.pair-card-who')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      all: !!c.querySelector('.pair-card-all.on'),
      heads: [...c.querySelectorAll('.pair-card-net')].map((e) => e.innerText.trim()),
      rows: [...c.querySelectorAll('.pair-row')].map((e) => ({ id: e.dataset.pairRow, text: e.innerText.replace(/\\s+/g, ' ').trim(), on: e.classList.contains('on'), sending: e.classList.contains('sending'), net: e.querySelector('.pair-row-net')?.innerText ?? '', ago: e.querySelector('.pair-row-ago')?.innerText ?? '' })),
      foot: c.querySelector('.pair-card-foot')?.innerText.trim() ?? '',
      box: { left: b.left, right: b.right, bottom: b.bottom },
    };
  })()`);

/** The switch row under the head: each tab's id, words, unread, whether it is chosen and has a glyph. */
const tabs = () =>
  p.eval<{ id: string; text: string; count: number; on: boolean; glyph: boolean; title: string }[]>(
    `[...document.querySelectorAll('.center .person-tabs [role=tab]')].map((t) => ({ id: t.dataset.tab, text: t.innerText.replace(/\\s+/g, ' ').trim(), count: Number(t.querySelector('.count')?.innerText ?? 0), on: t.getAttribute('aria-selected') === 'true', glyph: !!t.querySelector('svg'), title: t.title }))`,
  );
const chosenTab = () => p.eval<string>(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab ?? ''`);
const pickTab = async (id: string) => {
  await click(`.center .person-tabs [data-tab="${id}"]`);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === ${JSON.stringify(id)}`, 3000);
};
/** The messages drawn on the page, by id. */
const shownIds = () => p.eval<string[]>(`[...document.querySelectorAll('.center .pane [id^="m-"]')].map((e) => e.id.slice(2))`);
/** Every message id a route holds (a conversation's, or an email route's mail). */
const routeIds = async (id: string): Promise<Set<string>> => {
  const url = id.startsWith('email:') ? `${hub}/api/mail/chats/${encodeURIComponent(id)}/messages?limit=200` : `${hub}/api/conversations/${id}/messages?limit=200`;
  return new Set(((await fetch(url).then((r) => r.json())) as any).messages.map((m: any) => m.id));
};
/** Which of `routes` each drawn message is on ('?' for one on none of them). */
const shownOn = async (routes: string[]) => {
  const sets = await Promise.all(routes.map(async (r) => [r, await routeIds(r)] as const));
  return (await shownIds()).map((m) => sets.find(([, ids]) => ids.has(m))?.[0] ?? '?');
};
const chatRoute = async (pid: string) => ((await fetch(`${hub}/api/chats/${encodeURIComponent(`person:${pid}`)}`).then((r) => r.json())) as any).route;
const lead = () => text('.center .typing-lead');
/** A key with Ctrl and Shift held, by its physical key (`BracketRight`), as a real keyboard sends it. */
const chord = async (code: string, k: string, vk: number) => {
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers: 10, windowsVirtualKeyCode: vk });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: 10, windowsVirtualKeyCode: vk });
};

await p.size(1280, 800);

// ---- One route: the line says the network and your account, and nothing repeats the name.
await open(`#/c/${directs(jordan.id)[0].id}`);
const jLine = await text('.conv-head-sub');
check(await has('.conv-head-sub > .send-line'), 'a one-route DM: the line under the name is where your message goes', jLine);
check(!(await has('.conv-head .crumbs')) && !jLine.includes('Direct messages') && !jLine.includes('Jordan'), 'no "Direct messages › Name" crumb', jLine);
check((await lineNet('.conv-head-sub')) === 'Discord' && (await has('.conv-head-sub .acc-chip.with-net')) && !jLine.includes('Discord') && !jLine.includes('via'), 'it is your account, as one chip with Discord’s icon in it', jLine);
const lined = await starts();
check(lined.name === lined.line, 'the title starts where the line under it does', lined);
check((await badge()) === 'Discord', 'the picture’s badge is the network', await badge());
check(await has('.conv-head .pair-nick-edit'), 'the nickname pencil stays');
await shot('1-one-route-dm');

// ---- A group channel: its crumbs, exactly.
await open(`#/c/${channel.id}`);
const cLine = await text('.conv-head-sub');
check((await has('.conv-head .crumbs')) && !(await has('.conv-head .send-line')) && cLine.includes('›'), 'a server channel keeps its crumbs', cLine);
check(!!(await lineNet('.conv-head-sub')) && !cLine.includes(netName[channel.network]) && !cLine.includes(`#${channel.name}`), 'led by your account’s chip, with neither the network’s name nor the channel’s own', cLine);
await shot('7-group-channel');

// ---- A group: your account, then how many people; no "Groups", no name again.
if (group) {
  await open(`#/c/${group.id}`);
  const gLine = await text('.conv-head-sub');
  check(gLine.endsWith(`${group.participantIds.length} people`) && !gLine.includes('Groups') && (!group.name || !gLine.includes(group.name)) && !!(await lineNet('.conv-head-sub')), 'a group: your account’s chip and how many people', gLine);
  await shot('8-group');
}

// ---- Sam: Signal, Matrix and mail. The same line, the badge, and the switch row instead of a pill.
await open(`#/people/${sam.id}`);
let line = await text('.pair-dd-btn .send-line');
let net = await lineNet('.pair-dd-btn .send-line');
const samRoute = await chatRoute(sam.id);
const samNet = samRoute.conversationId.startsWith('email:') ? 'Email' : netName[boot.conversations.find((c: any) => c.id === samRoute.conversationId).network];
check(samNet === 'Email' ? line.includes('Email') : net === samNet && !line.includes(net), 'Sam’s chat: the same line, for the route messages go to', [samNet, net, line]);
check((await badge()) === samNet, 'the picture’s badge is the network you send on', await badge());
check(!(await has('.pair-more:not(.pair-only)')), 'no pill');
let t = await tabs();
check(JSON.stringify(t.map((x) => x.id)) === JSON.stringify(['all', 'net:matrix', 'net:signal', 'net:email']) && t[0].on && t.slice(1).every((x) => x.glyph) && !t[0].glyph, 'Sam’s row: All, Matrix, Signal, Email (by name, mail last), each network with its glyph, All chosen', t);
check(t.every((x) => x.title.includes('Ctrl+Shift+]')), 'the tabs’ tooltips name the keys', t[1]?.title);
await shot('2-sam-header');

// ---- Mo: two routes on one network, differing in their account: the line says which.
await open(`#/people/${mo.id}`);
line = await text('.pair-dd-btn .send-line');
check((await lineNet('.pair-dd-btn .send-line')) === 'Discord' && /^\S+ · to mo\.\w+$/.test(line), 'Mo: "[Discord icon] you · to mo.x"', line);
await openList();
let k = await card();
check(k?.heads.length === 1 && k.heads[0].toUpperCase() === 'DISCORD' && k.rows.length === 2 && k.rows.every((r) => /mo\.(codes|draws)/.test(r.text)), 'Mo’s list: one Discord heading, each row with its handle', k);
check(k?.who === 'Mo 2 accounts · 2 chats', 'its top says 2 accounts · 2 chats (one network left out)', k?.who);
await key('Escape');

// ---- Kit: eight routes on four networks.
await open(`#/people/${kit.id}`);
line = await text('.pair-dd-btn .send-line');
net = await lineNet('.pair-dd-btn .send-line');
check(Object.values(netName).includes(net) && (await badge()) === net, 'Kit’s chat: the line and the badge say the network you send on', [line, await badge()]);
t = await tabs();
check(JSON.stringify(t.map((x) => x.id)) === JSON.stringify(['all', 'net:discord', 'net:matrix', 'net:signal', 'net:telegram']) && t[0].on, 'Kit’s row: All, Discord, Matrix, Signal, Telegram, All chosen', t.map((x) => x.text));
check(!(await has('.pair-more:not(.pair-only)')), 'and no +N pill');
await shot('3-kit-header');
await openList();
k = await card();
check(k?.who === 'Kit 7 accounts · 8 chats · 4 networks' && k.all, 'the card’s top: Kit, 7 accounts · 8 chats · 4 networks, All on', k?.who);
check(JSON.stringify(k?.heads.map((h) => h.toUpperCase())) === JSON.stringify(['DISCORD', 'MATRIX']), 'headings for the networks of two or more routes', k?.heads);
const singles = k?.rows.filter((r) => r.net) ?? [];
check(singles.length === 2 && singles.map((r) => r.net).sort().join() === 'Signal,Telegram' && k!.rows.slice(-2).every((r) => r.net), 'Signal and Telegram after them, their line led by the network', singles.map((r) => r.text));
check(k?.rows.filter((r) => r.sending).length === 1 && k.rows.find((r) => r.sending)!.text.includes('➤ sending'), 'one row says ➤ sending', k?.rows.find((r) => r.sending)?.text);
check(k?.rows.some((r) => / via .+/.test(r.text)), 'a Discord row says via your account where yours differ', k?.rows.map((r) => r.text));
check(k?.foot === 'Kit’s profile →', 'the footer links to the profile', k?.foot);
check(k?.rows.every((r) => r.ago.length > 0), 'every row has its last activity', k?.rows.map((r) => r.ago));
await shot('4-kit-list');
if (before) {
  await key('Escape');
} else {
  // Pick a route that is not the one messages go to: the page filters to it and sends through it.
  const target = k!.rows.find((r) => !r.sending && !r.net)!;
  await click(`.pair-row[data-pair-row="${target.id}"]`);
  await p.until(`!document.querySelector('.pair-card')`, 2000).catch(() => {});
  check((await text('.pair-only')).replace(/\s/g, '') === 'onlythis✕', 'picked: the pill says only this ✕', await text('.pair-only'));
  const tconv = boot.conversations.find((c: any) => c.id === target.id);
  check((await chosenTab()) === `net:${tconv.network}`, 'the row shows the picked route’s network chosen', await chosenTab());
  check((await lineNet('.pair-dd-btn .send-line')) === netName[tconv.network] && (await badge()) === netName[tconv.network], 'the line and badge describe the picked route', await text('.pair-dd-btn .send-line'));
  await shot('5-kit-filtered');
  await openList();
  k = await card();
  check(!k?.all && k?.rows.find((r) => r.id === target.id)?.on && k.rows.find((r) => r.id === target.id)?.sending, 'the list: All off, the picked row highlighted and sending', k?.rows.find((r) => r.id === target.id));
  await key('Escape');
  check(!(await has('.pair-card')), 'Escape closes it');
  // A message sent now lands on the picked route.
  const body = `header check ${Date.now()}`;
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await p.send('Input.insertText', { text: body });
  await key('Enter');
  await Bun.sleep(1200);
  const landed = async (id: string) => ((await fetch(`${hub}/api/conversations/${id}/messages?limit=30`).then((r) => r.json())) as any).messages.some((m: any) => m.body === body);
  const where = [];
  for (const d of directs(kit.id)) if (await landed(d.id)) where.push(d.id);
  check(where.length === 1 && where[0] === target.id, 'a message sent while filtered lands on the picked route', where);
  // ✕ returns to all.
  await click('.pair-only');
  check((await chosenTab()) === 'all' && !(await has('.pair-only')), '✕ shows all chats together again', await chosenTab());
  // Press and drag down to a row and let go.
  const b = await at('.pair-dd-btn');
  await mouse('mousePressed', b.x, b.y);
  await p.until(`!!document.querySelector('.pair-card')`, 2000);
  const r = await p.eval<{ id: string; x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.pair-row')].find((e) => e.querySelector('.pair-row-net')?.innerText === 'Telegram'); const q = e.getBoundingClientRect(); return { id: e.dataset.pairRow, x: q.x + 60, y: q.y + q.height / 2 }; })()`);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', b.x + ((r.x - b.x) * i) / 5, b.y + ((r.y - b.y) * i) / 5);
  await mouse('mouseReleased', r.x, r.y, 0);
  await Bun.sleep(250);
  check(!(await has('.pair-card')) && (await lineNet('.pair-dd-btn .send-line')) === 'Telegram' && (await has('.pair-only')), 'press, drag to Telegram and let go: picked', await text('.pair-dd-btn .send-line'));
  // The keyboard: Enter opens on the row shown, the arrows move, Enter picks, Escape returns focus to the line.
  await p.eval(`document.querySelector('.pair-dd-btn').focus()`);
  await key('Enter');
  // The card puts the focus on a row once it is drawn: wait for that, not a fixed time.
  const rowFocused = `!!document.activeElement?.dataset?.pairRow`;
  await p.until(rowFocused, 3000);
  const f1 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  check(f1 === r.id, 'Enter on the line opens the card on the route shown', f1);
  await key('ArrowUp');
  await key('ArrowUp');
  const f2 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  await key('Escape');
  check(!(await has('.pair-card')) && (await p.eval<boolean>(`document.activeElement?.classList.contains('pair-dd-btn')`)), 'Escape closes and gives the line the focus back');
  await key('Enter');
  await p.until(rowFocused, 3000);
  for (let i = 0; i < 12; i++) await key('ArrowUp');
  const f3 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  await key('Enter');
  await p.until(`!document.querySelector('.pair-only')`, 3000);
  check(f2 !== r.id && f3 === 'all' && (await chosenTab()) === 'all' && !(await has('.pair-only')), 'the arrows move between rows, up to All, and Enter on it shows all', [f2, f3]);
  // The profile link.
  await openList();
  await click('.pair-card-foot');
  await p.until(`location.hash.includes(${JSON.stringify(kit.id)}) && !!document.querySelector('.profile-page')`, 5000).catch(() => {});
  check(await has('.profile-page'), 'the footer opens Kit’s profile', await p.eval(`location.hash`));
}


if (!before) {
  // ---- Kit's networks: a tab shows that network's routes together and sends through it; All brings everything back
  // and leaves the send route where it was.
  await open(`#/people/${kit.id}`);
  const kitAll = directs(kit.id).map((d: any) => d.id);
  const netOf = (id: string) => boot.conversations.find((c: any) => c.id === id)?.network ?? '?';
  await pickTab('net:discord');
  await p.until(`document.querySelectorAll('.center .pane [id^="m-"]').length > 1`, 10000);
  let on = await shownOn(kitAll);
  check(on.length > 1 && on.every((r) => netOf(r) === 'discord') && new Set(on).size >= 2, 'the Discord tab: only Discord’s messages, from several of its routes together', [...new Set(on)].map(netOf));
  check((await lineNet('.pair-dd-btn .send-line')) === 'Discord' && (await badge()) === 'Discord' && (await lead()).includes('on Discord'), 'and messages go through Discord', [await lineNet('.pair-dd-btn .send-line'), await lead()]);
  const viaDiscord = await text('.pair-dd-btn .send-line');
  await shot('10-kit-discord-tab');
  await pickTab('all');
  await p.until(`document.querySelectorAll('.center .pane [id^="m-"]').length > 1`, 10000);
  on = await shownOn(kitAll);
  check(new Set(on.map(netOf)).size > 1, 'All: every network’s messages again', [...new Set(on.map(netOf))]);
  check((await text('.pair-dd-btn .send-line')) === viaDiscord && (await lead()).includes('on Discord'), 'and the send route stays where the tab left it', [await text('.pair-dd-btn .send-line'), await lead()]);

  // Switching the route in the message box's line moves the tab with it.
  await pickTab('net:discord');
  await click('.center .typing-lead .pair-token');
  await p.until(`!!document.querySelector('.pair-menu')`, 3000);
  await click('.pair-menu .menu-item', 'on Signal');
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'net:signal'`, 3000).catch(() => {});
  check((await chosenTab()) === 'net:signal' && (await lead()).includes('on Signal'), 'switching to Signal in the message box’s line moves the tab to Signal', [await chosenTab(), await lead()]);
  on = await shownOn(kitAll);
  check(on.length > 0 && on.every((r) => netOf(r) === 'signal'), 'and shows Signal’s messages', [...new Set(on.map(netOf))]);

  // The keys move along the row from the message box, which keeps its focus and what is in it.
  await p.eval(`document.querySelector('.center .composer textarea').focus()`);
  await p.send('Input.insertText', { text: 'draft words' });
  await chord('BracketRight', '}', 221);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'net:telegram'`, 3000).catch(() => {});
  const box = () => p.eval<{ focused: boolean; value: string }>(`({ focused: !!document.activeElement?.matches('.center .composer textarea'), value: document.querySelector('.center .composer textarea')?.value ?? '' })`);
  let b = await box();
  check((await chosenTab()) === 'net:telegram' && b.focused && b.value === 'draft words', 'Ctrl+Shift+] moves to the next tab, the box keeping its focus and its text', [await chosenTab(), b]);
  await chord('BracketLeft', '{', 219);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'net:signal'`, 3000).catch(() => {});
  b = await box();
  check((await chosenTab()) === 'net:signal' && b.focused && b.value === 'draft words', 'Ctrl+Shift+[ moves back', [await chosenTab(), b]);
  for (let i = 0; i < 2; i++) await chord('BracketRight', '}', 221);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'all'`, 3000).catch(() => {});
  check((await chosenTab()) === 'all', 'and wraps round from the last tab to All', await chosenTab());
  await chord('BracketLeft', '{', 219);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'net:telegram'`, 3000).catch(() => {});
  await chord('BracketLeft', '{', 219);
  await p.until(`document.querySelector('.center .person-tabs [aria-selected=true]')?.dataset.tab === 'net:signal'`, 3000).catch(() => {});
  await p.eval(`(() => { const t = document.querySelector('.center .composer textarea'); t.focus(); t.select(); document.execCommand('delete'); })()`);
  check((await chosenTab()) === 'net:signal' && (await box()).value === '', 'back on Signal, the draft taken away', await chosenTab());

  // A tab counts what is unread there: Kit answers on Telegram while the page shows Signal, which leaves it unread.
  const tg = directs(kit.id).find((d: any) => d.network === 'telegram').id;
  const tgBefore = (await tabs()).find((x) => x.id === 'net:telegram')?.count ?? 0;
  const sent = await fetch(`${hub}/api/chats/${encodeURIComponent(`person:${kit.id}`)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: `tabs unread ${Date.now()}`, route: { conversationId: tg } }) });
  check(sent.ok, 'a message to Kit on Telegram, from outside the page', sent.status);
  // The demo answers a DM some seconds later.
  await p.until(`Number(document.querySelector('.center .person-tabs [data-tab="net:telegram"] .count')?.innerText ?? 0) > ${tgBefore}`, 20000).catch(() => {});
  t = await tabs();
  const tgTab = t.find((x) => x.id === 'net:telegram');
  check(!!tgTab && tgTab.count > tgBefore && t[0].count >= tgTab.count, 'their answer on Telegram counts on the Telegram tab and on All, not read while Signal is shown', t.map((x) => [x.id, x.count]));
  check((await chosenTab()) === 'net:signal' && (await lead()).includes('on Signal'), 'and a message on another network does not move the tab or the send route', [await chosenTab(), await lead()]);

  // ---- Sam, with mail and Signal: both under All, and each alone.
  const samMail = boot.mail.chats.find((c: any) => c.personId === sam.id)?.id;
  const samSig = directs(sam.id).find((d: any) => d.network === 'signal')?.id;
  const samAll = [...directs(sam.id).map((d: any) => d.id), samMail];
  await open(`#/people/${sam.id}`);
  on = await shownOn(samAll);
  check(!!samMail && on.includes(samMail) && on.includes(samSig) && !on.includes('?'), 'Sam under All: their mail and their Signal messages in one page', [...new Set(on)]);
  await shot('11-sam-all');
  await pickTab('net:signal');
  await p.until(`document.querySelectorAll('.center .pane [id^="m-"]').length > 0`, 10000);
  on = await shownOn(samAll);
  check(on.length > 0 && on.every((r) => r === samSig), 'Sam on Signal: Signal alone', [...new Set(on)]);
  await pickTab('net:email');
  await p.until(`document.querySelectorAll('.center .pane [id^="m-"]').length > 0`, 10000);
  on = await shownOn(samAll);
  check(on.length > 0 && on.every((r) => r === samMail) && (await lead()).includes('on Email'), 'Sam on Email: their mail alone, sent by email', [[...new Set(on)], await lead()]);
  await shot('12-sam-email');

  // ---- A tag on a name line (a route's after the time, a mail's subject), with the pane narrow (the details panel
  // open): the bar that shows over a hovered message would reach it there, and stays above the line instead, so a press
  // on the tag never lands on a reaction. Each row's bar is shown and measured in one pass, with no pointer.
  await p.size(1190, 800);
  await p.eval(`(localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), details: true })), (window.__before = true), (location.hash = ${JSON.stringify(`#/people/${sam.id}`)}), location.reload())`).catch(() => {});
  await p.until(`!window.__before && document.querySelectorAll('.center .pane .msg .route-tag').length > 0`, 15000);
  const bars = await p.eval<{ reaches: boolean; covers: boolean }[]>(
    `[...document.querySelectorAll('.center .pane .msg .route-tag')].flatMap((tag) => { const bar = tag.closest('.msg').querySelector(':scope > .msg-actions'); if (!bar) return []; bar.style.display = 'flex'; const b = bar.getBoundingClientRect(), t = tag.getBoundingClientRect(); bar.style.display = ''; const reaches = b.left < t.right && b.right > t.left; return [{ reaches, covers: reaches && b.top < t.bottom && b.bottom > t.top }]; })`,
  );
  check(bars.some((x) => x.reaches), 'with the details panel open the pane is narrow enough for a message’s bar to reach the tag on its name line', bars.length);
  check(bars.length > 0 && !bars.some((x) => x.covers), '…and the bar stays above the line: it never covers the tag', bars.filter((x) => x.covers).length);
  await shot('13-sam-narrow');
  await p.size(1280, 800);
  await p.eval(`(localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), details: false })), (window.__before = true), location.reload())`).catch(() => {});
  await p.until(`!window.__before && !!document.querySelector('.conv-head')`, 15000);

  // ---- An email route chosen is kept by the hub: Alice wrote on Signal last, Email is chosen, and a reload starts there.
  const alice = boot.persons.find((q: any) => q.name === 'Alice Chen' && boot.mail.chats.some((c: any) => c.personId === q.id));
  const aliceMail = boot.mail.chats.find((c: any) => c.personId === alice.id).id;
  await open(`#/people/${alice.id}`);
  check(!(await lead()).includes('on Email'), 'Alice’s page starts on the route of her latest message, not Email', await lead());
  await pickTab('net:email');
  const chosen = `fetch('/api/chats/${encodeURIComponent(`person:${alice.id}`)}').then((r) => r.json()).then((v) => v.route?.conversationId === ${JSON.stringify(aliceMail)} && v.route.why === 'chosen')`;
  await p.until(chosen, 5000).catch(() => {});
  check(await p.eval<boolean>(chosen), 'picking her Email tab makes Email the chat’s route on the hub', await chatRoute(alice.id));
  await p.eval(`location.reload()`).catch(() => {});
  await Bun.sleep(500);
  await p.until(`document.querySelectorAll('.msg').length > 1 && (document.querySelector('.center .typing-lead')?.innerText ?? '').includes('on Email')`, 15000).catch(() => {});
  check((await lead()).includes('on Email') && (await chosenTab()) === 'all', 'after a reload the page shows All and still sends by Email', [await lead(), await chosenTab()]);
}

// ---- A phone: Kit's header and the list fit 390.
await p.size(390, 844, true);
await open(`#/people/${kit.id}`);
await shot('6-phone-kit-header');
await openList();
k = await card();
const sw = await p.eval<number>(`document.documentElement.scrollWidth`);
check(k && k.box.left >= 0 && k.box.right <= 390 && k.box.bottom <= 844 && sw <= 390, 'on a phone the card fits 390 wide', [k?.box, sw]);
await shot('6-phone-kit-list');
await key('Escape');

if (!before) {
  // ---- A phone: Alice on six networks: the row is wider than the page and scrolls inside it, and a sideways drag on
  // it is the row's, never the page's swipe back.
  const alice = boot.persons.find((q: any) => q.name === 'Alice Chen' && boot.mail.chats.some((c: any) => c.personId === q.id));
  await open(`#/people/${alice.id}`);
  const row = await p.eval<{ sw: number; cw: number; right: number; top: number; h: number; doc: number }>(
    `(() => { const r = document.querySelector('.center .person-tabs'); const b = r.getBoundingClientRect(); return { sw: r.scrollWidth, cw: r.clientWidth, right: b.right, top: b.top, h: b.height, doc: document.documentElement.scrollWidth }; })()`,
  );
  check(row.sw > row.cw && row.right <= 390 && row.doc <= 390, 'on a phone Alice’s row is wider than the page, scrolls inside it, and the page does not scroll sideways', row);
  const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
  const swipe = async (a: [number, number], to: [number, number]) => {
    await touch('touchStart', [a]);
    for (let i = 1; i <= 14; i++) {
      await touch('touchMove', [[a[0] + ((to[0] - a[0]) * i) / 14, a[1] + ((to[1] - a[1]) * i) / 14]]);
      await Bun.sleep(16);
    }
    await touch('touchEnd', []);
  };
  // Headless Chromium can drop the first touches of a new page: wait until one reaches it.
  await p.eval(`(() => { window.__touched = false; addEventListener('touchstart', () => (window.__touched = true), { capture: true, once: true }); })()`);
  for (let i = 0; i < 30 && !(await p.eval<boolean>('window.__touched')); i++) {
    await touch('touchStart', [[195, 4]]);
    await touch('touchCancel', []);
    await Bun.sleep(150);
  }
  const y = Math.round(row.top + row.h / 2);
  const here = await p.eval<string>('location.hash');
  const settled = `document.querySelector('.center')?.style.transform === 'none' || document.querySelector('.center')?.style.transform === ''`;
  // At the row's start a drag to the right is what a swipe back is anywhere else on the page.
  await swipe([30, y], [320, y]);
  await p.until(settled, 3000).catch(() => {});
  check((await p.eval<string>('location.hash')) === here && (await has('.center .person-tabs')), 'a drag to the right along the row at its start does not go back', await p.eval('location.hash'));
  await swipe([360, y], [40, y]);
  await p.until(`document.querySelector('.center .person-tabs').scrollLeft > 0`, 3000).catch(() => {});
  const left = await p.eval<number>(`document.querySelector('.center .person-tabs').scrollLeft`);
  check(left > 0 && (await p.eval<string>('location.hash')) === here, 'a drag to the left scrolls the row', left);
  await shot('9-phone-alice-tabs');
  // The same drag on the messages is a swipe back, so the touches above did reach the page.
  await swipe([30, 500], [320, 500]);
  await p.until(`location.hash !== ${JSON.stringify(here)}`, 3000).catch(() => {});
  check((await p.eval<string>('location.hash')) !== here, 'while the same drag on the messages goes back', await p.eval('location.hash'));
}

// ---- The light theme, Kit's list.
await p.size(1280, 800);
await theme('dither-light', `#/people/${kit.id}`);
await openList();
await shot('8-light-kit-list');
await key('Escape');
await theme('dither-dark', `#/people/${kit.id}`);

check(!p.errors.length, 'no page errors', p.errors.slice(0, 5));
await close();
if (!before) console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
