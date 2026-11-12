/**
 * The chat header (docs/chats.md, The page), end to end against a multiaccount demo hub in headless Chromium: the line
 * under the name says where your message goes in the same words for a one-route DM and a person's chat (network ·
 * via your account), with no "Direct messages › Name" crumb; a group channel keeps its crumbs; the picture's badge is
 * the network you send on; a chat of several routes adds one pill (`+N ▾`, `only this ✕` while filtered); the route
 * list is a card (the person, counts, All, routes by network, sending, the profile link); picking a row by click, by
 * press-and-drag and by the keyboard; a message sent while filtered lands on the picked route; a phone of 390 and
 * the light theme; and no page errors.
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

await p.size(1280, 800);

// ---- One route: the line says the network and your account, and nothing repeats the name.
await open(`#/c/${directs(jordan.id)[0].id}`);
const jLine = await text('.conv-head-sub');
check(await has('.conv-head-sub > .send-line'), 'a one-route DM: the line under the name is where your message goes', jLine);
check(!(await has('.conv-head .crumbs')) && !jLine.includes('Direct messages') && !jLine.includes('Jordan'), 'no "Direct messages › Name" crumb', jLine);
check(/^Discord · via \S+/.test(jLine), 'it reads "Discord · via <your account>"', jLine);
check((await badge()) === 'Discord', 'the picture’s badge is the network', await badge());
check(await has('.conv-head .pair-nick-edit'), 'the nickname pencil stays');
await shot('1-one-route-dm');

// ---- A group channel: its crumbs, exactly.
await open(`#/c/${channel.id}`);
const cLine = await text('.conv-head-sub');
check((await has('.conv-head .crumbs')) && !(await has('.conv-head .send-line')) && cLine.includes('›'), 'a group channel keeps its crumbs', cLine);
await shot('7-group-channel');

// ---- Sam: two networks. The same line, the badge, and one pill.
await open(`#/people/${sam.id}`);
let line = await text('.pair-dd-btn .send-line');
let net = line.split(' ')[0];
check(['Signal', 'Matrix'].includes(net) && line.includes('· via'), 'Sam’s chat: the same line, for the route messages go to', line);
check((await badge()) === net, 'the picture’s badge is the network you send on', await badge());
check((await text('.pair-more')).replace(/\s/g, '') === '+1▾', 'one pill: +1 ▾', await text('.pair-more'));
await shot('2-sam-header');

// ---- Mo: two routes on one network, differing in their account: the line says which.
await open(`#/people/${mo.id}`);
line = await text('.pair-dd-btn .send-line');
check(/^Discord · to mo\.\w+ · via \S+/.test(line), 'Mo: "Discord · to mo.x · via you"', line);
await openList();
let k = await card();
check(k?.heads.length === 1 && k.heads[0].toUpperCase() === 'DISCORD' && k.rows.length === 2 && k.rows.every((r) => /mo\.(codes|draws)/.test(r.text)), 'Mo’s list: one Discord heading, each row with its handle', k);
check(k?.who === 'Mo 2 accounts · 2 chats', 'its top says 2 accounts · 2 chats (one network left out)', k?.who);
await key('Escape');

// ---- Kit: eight routes on four networks.
await open(`#/people/${kit.id}`);
line = await text('.pair-dd-btn .send-line');
net = line.split(' ')[0];
check(Object.values(netName).includes(net) && (await badge()) === net, 'Kit’s chat: the line and the badge say the network you send on', [line, await badge()]);
const pill = await p.eval<{ text: string; glyphs: number }>(`(() => { const e = document.querySelector('.pair-more'); return { text: e?.innerText.replace(/\\s/g, '') ?? '', glyphs: e?.querySelectorAll('svg').length ?? 0 }; })()`);
check(pill.text === '+7▾' && pill.glyphs >= 1 && pill.glyphs <= 3, 'the pill: other networks’ glyphs (at most 3) and +7', pill);
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
  check(!(await has('.pair-more:not(.pair-only)')), 'and the +N pill gives way to it');
  const tconv = boot.conversations.find((c: any) => c.id === target.id);
  check((await text('.pair-dd-btn .send-line')).startsWith(netName[tconv.network]) && (await badge()) === netName[tconv.network], 'the line and badge describe the picked route', await text('.pair-dd-btn .send-line'));
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
  check((await text('.pair-more')).replace(/\s/g, '') === '+7▾' && !(await has('.pair-only')), '✕ shows all chats together again', await text('.pair-more'));
  // Press and drag down to a row and let go.
  const b = await at('.pair-dd-btn');
  await mouse('mousePressed', b.x, b.y);
  await p.until(`!!document.querySelector('.pair-card')`, 2000);
  const r = await p.eval<{ id: string; x: number; y: number }>(`(() => { const e = [...document.querySelectorAll('.pair-row')].find((e) => e.querySelector('.pair-row-net')?.innerText === 'Telegram'); const q = e.getBoundingClientRect(); return { id: e.dataset.pairRow, x: q.x + 60, y: q.y + q.height / 2 }; })()`);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', b.x + ((r.x - b.x) * i) / 5, b.y + ((r.y - b.y) * i) / 5);
  await mouse('mouseReleased', r.x, r.y, 0);
  await Bun.sleep(250);
  check(!(await has('.pair-card')) && (await text('.pair-dd-btn .send-line')).startsWith('Telegram') && (await has('.pair-only')), 'press, drag to Telegram and let go: picked', await text('.pair-dd-btn .send-line'));
  // The keyboard: Enter opens on the row shown, the arrows move, Enter picks, Escape returns focus to the line.
  await p.eval(`document.querySelector('.pair-dd-btn').focus()`);
  await key('Enter');
  const f1 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  check(f1 === r.id, 'Enter on the line opens the card on the route shown', f1);
  await key('ArrowUp');
  await key('ArrowUp');
  const f2 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  await key('Escape');
  check(!(await has('.pair-card')) && (await p.eval<boolean>(`document.activeElement?.classList.contains('pair-dd-btn')`)), 'Escape closes and gives the line the focus back');
  await key('Enter');
  for (let i = 0; i < 12; i++) await key('ArrowUp');
  const f3 = await p.eval<string>(`document.activeElement?.dataset?.pairRow ?? ''`);
  await key('Enter');
  check(f2 !== r.id && f3 === 'all' && (await has('.pair-more')) && !(await has('.pair-only')), 'the arrows move between rows, up to All, and Enter on it shows all', [f2, f3]);
  // The profile link.
  await openList();
  await click('.pair-card-foot');
  await p.until(`location.hash.includes(${JSON.stringify(kit.id)}) && !!document.querySelector('.profile-page')`, 5000).catch(() => {});
  check(await has('.profile-page'), 'the footer opens Kit’s profile', await p.eval(`location.hash`));
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
