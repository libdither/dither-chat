/**
 * New group from the palette (docs/group-settings.md "Making a group", docs/palette.md), end to end against a demo hub
 * in headless Chromium: from the + to New group, two Discord friends, Where, an optional name, Make, and a message sent
 * in the new group DM; a Signal group says Dad was invited; a Matrix room says it invites, and while it is being made
 * Escape and back do not leave; a Telegram group says Noor's privacy sentence and the basic-group note; people who
 * share no one network go to Where with "2 of 3" and who is left out, and WhatsApp's line; a required name is refused
 * in words before any request; the day's Telegram groups run out and the 429 shows on the page; backing out from the
 * name to Where to the people keeps the picks and the name; a keyboard-only run from Ctrl+K typing "new group"; "New
 * group with <name>" from a DM; and a phone: it fits, a back chevron, the title whole. Screenshots dark, light, phone.
 *
 *   bun scripts/verify-groups.ts http://127.0.0.1:8821 [/tmp/shots]
 * It makes groups in the demo world: point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8821';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const person = (name: string) => boot.persons.find((p: any) => p.name === name && p.identityIds.length)?.id as string;
const [ravi, jordan, mom, dad, kai, alice, quinn, theo] = ['Ravi', 'Jordan', 'Mom', 'Dad', 'kai', 'Alice Chen', 'Quinn', 'Theo'].map(person);
const noor = boot.persons.find((p: any) => p.name === 'Noor' && p.identityIds.some((id: string) => boot.identities.find((i: any) => i.id === id)?.network === 'telegram'))?.id;
const tgAcc = boot.accounts.find((a: any) => a.network === 'telegram');
const raviDm = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord' && c.peerPersonId === ravi);
if (![ravi, jordan, mom, dad, kai, alice, quinn, theo, noor, tgAcc, raviDm].every(Boolean)) throw new Error('the demo world lacks someone this checks');

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
  await Bun.sleep(120);
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const CODES: Record<string, number> = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
const key = async (k: string, modifiers = 0) => {
  const code = CODES[k] ?? k.toUpperCase().charCodeAt(0);
  const c = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: c, modifiers, windowsVirtualKeyCode: code, ...(k === 'Enter' && !modifiers ? { text: '\r' } : {}) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: c, modifiers, windowsVirtualKeyCode: code });
  await Bun.sleep(120);
};
const type = async (s: string) => {
  await p.send('Input.insertText', { text: s });
  await Bun.sleep(150);
};
const pageIs = (page: string | null, ms = 6000) => p.until(page ? `document.querySelector('.palette')?.dataset.page === ${JSON.stringify(page)} && !!document.querySelector('.palette .palette-page')` : `!document.querySelector('.palette')`, ms);
const peopleReady = () => p.until(`!!document.querySelector('.new-group .fwd-row')`, 10000);
const pick = (key: string) => click(`.new-group .fwd-row[data-key="${key}"]`);
const fit = () => text('.group-fit');
const title = () => text('.palette-title');
const input = () => p.eval<string | null>(`document.querySelector('.palette-input')?.value ?? null`);
const picked = () => p.eval<string[]>(`[...document.querySelectorAll('.new-group .fwd-row.on')].map((r) => r.dataset.key)`);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const bootstrap = () => fetch(`${hub}/api/bootstrap`).then((r) => r.json()) as Promise<any>;
/** Counts the page's POSTs to /api/groups, and can hold one back for a moment, to see the page while it is asked. */
const watchPosts = () =>
  p.eval(`(() => { if (window.__posts !== undefined) return; window.__posts = 0; window.__hold = 0; const f = window.fetch; window.fetch = async (u, o) => { if (String(u).endsWith('/api/groups') && o?.method === 'POST') { window.__posts++; if (window.__hold) await new Promise((r) => setTimeout(r, window.__hold)); } return f(u, o); }; })()`);
const posts = () => p.eval<number>('window.__posts');
const toastText = async () => {
  await p.until(`!!document.querySelector('.toast')`, 5000).catch(() => {});
  return text('.toast');
};
const dismissToasts = () => p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
const load = async (path: string) => {
  await p.goto('about:blank');
  await p.goto(`${hub}/${path}`);
  await p.until(`!!document.querySelector('.side-new')`, 20000);
  await watchPosts();
};
/** From the + : New, then New group. */
const openNewGroup = async () => {
  await click('.side-new');
  await pageIs('new');
  await click('.palette [data-key="n:group"]');
  await pageIs('group');
  await peopleReady();
};
/** On the name page: what the page says, the button, its problem. */
const namePage = () =>
  p.eval<{ title: string; placeholder: string; button: string; disabled: boolean; problem: string; people: string[]; left: string; invite: string; error: string }>(`(() => ({
    title: document.querySelector('.palette-title')?.textContent ?? '',
    placeholder: document.querySelector('.palette-input')?.placeholder ?? '',
    button: document.querySelector('.group-make')?.textContent.trim() ?? '',
    disabled: !!document.querySelector('.group-make')?.disabled,
    problem: document.querySelector('.group-problem')?.textContent ?? '',
    people: [...document.querySelectorAll('.group-person-name')].map((e) => e.textContent.trim()),
    left: document.querySelector('.group-left')?.textContent ?? '',
    invite: document.querySelector('.group-invite')?.textContent ?? '',
    error: document.querySelector('.group-error')?.textContent.trim() ?? '',
  }))()`);
const groupIds = async () => new Set<string>((await bootstrap()).conversations.filter((c: any) => c.shape === 'group').map((c: any) => c.id));

try {
  await p.size(1280, 820);
  await load('#/inbox');

  // 1. From the +: New group, two Discord friends, Where (both Discord accounts reach them), an optional name, Make.
  await openNewGroup();
  check((await title()) === 'New group' && (await text('.palette-crumb')).includes('New'), 'the + → New → New group: a page on New', await title());
  const rows = await p.eval<string[]>(`[...document.querySelectorAll('.new-group .fwd-row')].map((r) => r.dataset.key)`);
  check(rows.includes(ravi) && rows.includes(mom) && rows.includes(kai) && new Set(rows).size === rows.length, 'one row per person, from every account', rows.length);
  const aliceNets = await p.eval<string[]>(`[...document.querySelectorAll('.new-group .fwd-row[data-key="${alice}"] .group-net')].map((n) => n.dataset.network)`);
  check(['discord', 'signal', 'matrix', 'telegram'].every((n) => aliceNets.includes(n)) && !aliceNets.includes('whatsapp'), 'a row shows the networks they can be put in a group on', aliceNets);
  check((await text('.new-group .group-unable')).includes('left out on WhatsApp'), "WhatsApp's line, once, at the end of the list", await text('.new-group .group-unable'));
  await pick(ravi);
  check((await fit()) === 'A Discord group DM starts with at least 2 friends', 'one Discord friend: the fit line says what Discord needs', await fit());
  await pick(jordan);
  check((await fit()) === 'Only Discord reaches both', 'two Discord friends: only Discord reaches both', await fit());
  check((await text('.group-next .btn')).trim() === 'Next' && (await text('.new-group .fwd-chip')).includes('Ravi'), 'chips, and Next', await text('.group-next'));
  await shot('groups-01-people');
  await click('.group-next .btn');
  await pageIs('group-where');
  const where = await p.eval<{ label: string; sub: string }[]>(`[...document.querySelectorAll('.group-where-row')].map((r) => ({ label: r.querySelector('.switcher-label').textContent, sub: r.querySelector('small').textContent }))`);
  check(where.length === 2 && where.every((w) => w.label.startsWith('Discord · ') && w.sub === 'Group DM with both'), 'Where: both Discord accounts, each a group DM with both', where);
  await click('.group-where-row');
  await pageIs('group-name');
  let n = await namePage();
  check(n.placeholder === 'Name (optional)' && n.button === 'Make group DM' && !n.disabled && n.people.join() === 'Ravi,Jordan', 'the name page: optional name, Make group DM, the people', n);
  let before = await groupIds();
  await key('Enter');
  await pageIs(null, 8000);
  await p.until(`location.hash.includes('/c/')`, 8000).catch(() => {});
  let after = await bootstrap();
  let fresh = after.conversations.filter((c: any) => c.shape === 'group' && !before.has(c.id));
  check(fresh.length === 1 && fresh[0].network === 'discord' && (await hash()).includes(fresh[0].id), 'Enter makes it and lands in the new group DM', { hash: await hash(), fresh: fresh.map((c: any) => c.id) });
  check((await toastText()).includes('Made '), 'and says it was made', await toastText());
  await dismissToasts();
  // A message sends there.
  const said = `hello group ${Date.now().toString(36)}`;
  await p.until(`!!document.querySelector('.composer textarea')`, 6000);
  await p.eval(`document.querySelector('.composer textarea').focus()`);
  await type(said);
  await key('Enter');
  await p.until(`[...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].some((e) => e.textContent.trim() === ${JSON.stringify(said)})`, 8000).catch(() => {});
  check(await p.eval(`[...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].some((e) => e.textContent.trim() === ${JSON.stringify(said)})`), 'a message sends in the new group DM');

  // 2. Signal with Dad: only Signal reaches them, so Where is skipped; a required name refused before any request.
  await openNewGroup();
  await pick(mom);
  await pick(dad);
  check((await fit()) === 'Only Signal reaches both', 'Mom and Dad: only Signal', await fit());
  const postsBefore = await posts();
  await key('Enter', 2);
  await pageIs('group-name');
  n = await namePage();
  check(n.placeholder === 'Name the group' && n.disabled && n.problem === 'Give the group a name' && (await text('.palette-crumb')).includes('New group') && !(await text('.palette-crumb')).includes('Where'), 'one account reaches both: straight to the name; no name, the button off with the rule in words', n);
  await key('Enter');
  await click('.group-make').catch(() => {});
  check((await posts()) === postsBefore && (await p.eval(`document.querySelector('.palette')?.dataset.page`)) === 'group-name', 'and nothing is asked of the hub', await posts());
  await type('x'.repeat(33));
  n = await namePage();
  check(n.disabled && n.problem === "A Signal group's name is at most 32 characters", 'a name too long: refused in words', n.problem);
  await p.eval(`(() => { const i = document.querySelector('.palette-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await type('Parents');
  await shot('groups-03-name');
  before = await groupIds();
  await click('.group-make');
  await pageIs(null, 8000);
  const sig = await toastText();
  after = await bootstrap();
  fresh = after.conversations.filter((c: any) => c.shape === 'group' && !before.has(c.id));
  check(fresh.length === 1 && fresh[0].network === 'signal' && fresh[0].name === 'Parents' && (await hash()).includes(fresh[0].id), 'a Signal group, named, and there', fresh.map((c: any) => [c.network, c.name]));
  check(sig.includes('Made Parents') && sig.includes('Invited Dad: in once they accept'), 'it says Dad was invited', sig);
  check((await posts()) === postsBefore + 1, 'one request in all', await posts());
  await dismissToasts();

  // 3. A Matrix room: invites; while it is asked, Escape and back do not leave.
  await openNewGroup();
  await pick(kai);
  await click('.group-next .btn');
  await pageIs('group-name');
  n = await namePage();
  check(n.placeholder === 'Name the room' && n.button === 'Make room' && n.invite === 'They get an invite and are in once they accept.', 'a Matrix room: it says they are invited', n);
  await type('Book swap');
  await p.eval('window.__hold = 1500');
  before = await groupIds();
  await click('.group-make');
  await Bun.sleep(200);
  check((await text('.group-make')).trim() === 'Making…' && (await p.eval(`document.querySelector('.group-make').disabled`)), 'Making…, and the button off');
  await key('Escape');
  await p.eval('history.back()');
  await Bun.sleep(300);
  check((await p.eval(`document.querySelector('.palette')?.dataset.page`)) === 'group-name', 'Escape and the back button do not leave while it is made');
  await pageIs(null, 8000);
  await p.eval('window.__hold = 0');
  const mx = await toastText();
  after = await bootstrap();
  fresh = after.conversations.filter((c: any) => c.shape === 'group' && !before.has(c.id));
  check(fresh.length === 1 && fresh[0].network === 'matrix' && mx.includes('Invited kai'), 'the room is made, and kai invited', mx);
  await dismissToasts();

  // 4. Telegram: Noor's privacy sentence and the basic-group note.
  await openNewGroup();
  await pick(noor);
  await pick(alice);
  check((await fit()) === 'Only Telegram reaches both', 'Noor and Alice: only Telegram', await fit());
  await click('.group-next .btn');
  // Signal and Matrix could hold Alice alone: Where, Telegram first.
  await pageIs('group-where');
  check((await text('.group-where-row .switcher-label')).startsWith('Telegram'), 'Where: Telegram, which reaches both, first', await text('.group-where-row'));
  await click('.group-where-row', 'Telegram');
  await pageIs('group-name');
  await type('Film club');
  await click('.group-make');
  await pageIs(null, 8000);
  const tg = await toastText();
  check(tg.includes('Made Film club') && tg.includes("Could not add Noor: Their privacy settings don't let you add them to groups.") && tg.includes('Telegram made it a basic group'), "Noor's privacy sentence and the basic-group note", tg);
  await dismissToasts();

  // 5. No one network: Where with "2 of 3" and who is left out; WhatsApp's line. Then back out, keeping everything.
  await openNewGroup();
  for (const k of [ravi, jordan, mom]) await pick(k);
  check((await fit()) === 'No one network reaches all 3: Discord reaches 2, Signal 1', 'the fit line: no one network reaches all 3', await fit());
  await click('.group-next .btn');
  await pageIs('group-where');
  const opts = await p.eval<{ label: string; sub: string }[]>(`[...document.querySelectorAll('.group-where-row')].map((r) => ({ label: r.querySelector('.switcher-label').textContent, sub: r.querySelector('small').textContent }))`);
  check(opts[0]?.label.startsWith('Discord') && opts[0].sub === 'Group DM with 2 of 3: not Mom' && opts.some((o) => o.label === 'Signal' && o.sub === 'Group with 1 of 3: not Ravi and Jordan'), 'Where: Discord with 2 of 3, not Mom; Signal with 1 of 3', opts);
  const why = await text('.group-why');
  check(why.includes('left out on WhatsApp') && why.includes('Matrix: a room starts with at least 1 person, and none of them is known there'), "the others say why, and WhatsApp's line", why);
  await shot('groups-02-where');
  await click('.group-where-row');
  await pageIs('group-name');
  check((await text('.group-left')) === 'Not in it: Mom, who is not a Discord friend here', 'the name page says who is left out', await text('.group-left'));
  await type('Raid night');
  await key('Escape');
  await pageIs('group-where');
  await key('Escape');
  await pageIs('group');
  check((await picked()).sort().join() === [ravi, jordan, mom].sort().join(), 'backing out to the people: the picks kept', await picked());
  await click('.group-next .btn');
  await pageIs('group-where');
  await click('.group-where-row');
  await pageIs('group-name');
  check((await input()) === 'Raid night', 'and forward again: the name kept', await input());
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await pageIs(null);

  // 6. The day's Telegram groups run out (3): the 429 on the page, nothing lost.
  for (let i = 0; i < 2; i++)
    await p.eval(`fetch('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: ${JSON.stringify(tgAcc.id)}, name: 'Pace ${i}', identities: [${JSON.stringify(boot.identities.find((i: any) => i.network === 'telegram' && i.personId === alice).id)}] }) }).then((r) => r.status)`);
  await openNewGroup();
  await pick(noor);
  await pick(alice);
  await click('.group-next .btn');
  await pageIs('group-where');
  await click('.group-where-row', 'Telegram');
  await pageIs('group-name');
  await type('One too many');
  await click('.group-make');
  await p.until(`!!document.querySelector('.group-error')`, 8000).catch(() => {});
  n = await namePage();
  check(/limit|tomorrow|a day|try again|next/i.test(n.error) && n.button === 'Make group' && !n.disabled && (await input()) === 'One too many', 'past the day’s groups: the hub’s sentence on the page, the button back, the name kept', n);
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await pageIs(null);

  // 7. Keyboard only, from Ctrl+K: "new group", Quinn and Theo, Where, a name, Enter.
  await key('k', 2);
  await pageIs('root');
  await type('new group');
  check((await p.eval(`document.querySelector('.palette [data-row].active')?.dataset.key`)) === 'a:group', 'Ctrl+K "new group": New group first');
  for (const q of ['gc', 'group chat']) {
    await p.eval(`(() => { const i = document.querySelector('.palette-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await Bun.sleep(100);
    check((await p.eval(`document.querySelector('.palette [data-row].active')?.dataset.key`)) === 'a:group', `and "${q}" finds it`);
  }
  await key('Enter');
  await pageIs('group');
  await peopleReady();
  await type('quinn');
  await key('Enter');
  for (let i = 0; i < 5; i++) await key('Backspace');
  await type('theo');
  await key('Enter');
  // The list shows what matches "theo"; the chips show everyone picked.
  check((await text('.new-group .fwd-chip')) === 'Quinn | Theo', 'Enter picks', await text('.new-group .fwd-chip'));
  await key('Enter', 2);
  await pageIs('group-where');
  await key('Enter');
  await pageIs('group-name');
  const kbNoun = (await namePage()).button;
  await type('Keys only');
  before = await groupIds();
  await key('Enter');
  await pageIs(null, 8000);
  after = await bootstrap();
  fresh = after.conversations.filter((c: any) => c.shape === 'group' && !before.has(c.id));
  check(fresh.length === 1 && (await hash()).includes(fresh[0].id), 'Ctrl+Enter, Enter on Where, a name and Enter: made, by keys alone', { kbNoun, fresh: fresh.map((c: any) => c.network) });
  await dismissToasts();

  // 8. From a DM: "New group with Ravi", Ravi picked.
  await load(`#/inbox/c/${raviDm.id}`);
  await click('.side-new');
  await pageIs('new');
  const first = await p.eval<{ key: string; label: string }>(`(() => { const r = document.querySelector('.palette [data-row]'); return { key: r.dataset.key, label: r.textContent.trim() }; })()`);
  check(first.key === 'n:group-with' && first.label === 'New group with Ravi', 'a DM on screen: New group with Ravi, first', first);
  await key('Enter');
  await pageIs('group');
  await peopleReady();
  await p.until(`document.querySelectorAll('.new-group .fwd-row.on').length > 0`, 4000).catch(() => {});
  check((await picked()).join() === ravi, 'Ravi is picked already', await picked());
  await key('Escape');
  await key('Escape');
  await pageIs(null);

  // 9. A light theme.
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-light' }))`);
  await load('#/inbox');
  await openNewGroup();
  await pick(ravi);
  await pick(mom);
  await shot('groups-04-people-light');
  await click('.group-next .btn');
  await pageIs('group-where');
  await shot('groups-05-where-light');
  await click('.group-where-row', 'Signal');
  await pageIs('group-name');
  await shot('groups-06-name-light');
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await key('Escape');
  await pageIs(null);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-dark' }))`);

  // 10. A phone: fits, a back chevron in place of the crumbs, the title whole.
  await p.size(390, 844, true);
  await load('#/inbox');
  await click('.side-new');
  await pageIs('new');
  check((await p.eval(`document.querySelector('.palette-input').placeholder`)) === 'Name, link, @name or phone', "New's placeholder on a phone is the short one");
  await click('.palette [data-key="n:group"]');
  await pageIs('group');
  await peopleReady();
  await Bun.sleep(400);
  const box = () =>
    p.eval<{ w: number; scroll: number; inside: boolean; chevron: boolean; crumbs: number; whole: boolean; title: string }>(`(() => {
      const b = document.querySelector('.palette');
      const t = document.querySelector('.palette-title');
      return { w: Math.round(b.getBoundingClientRect().width), scroll: document.documentElement.scrollWidth, inside: b.scrollWidth <= b.clientWidth + 1, chevron: !!document.querySelector('.palette-back-btn'), crumbs: document.querySelectorAll('.palette-crumb').length, whole: t.scrollWidth <= t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1, title: t.textContent };
    })()`);
  let ph = await box();
  check(ph.w === 390 && ph.scroll <= 390 && ph.inside && ph.chevron && !ph.crumbs && ph.whole, 'on a phone: fits, a back chevron, no crumbs, the title whole', ph);
  await pick(ravi);
  await pick(jordan);
  await pick(mom);
  await shot('groups-07-phone-people');
  await click('.group-next .btn');
  await pageIs('group-where');
  await Bun.sleep(300);
  await shot('groups-08-phone-where');
  await click('.group-where-row');
  await pageIs('group-name');
  await Bun.sleep(300);
  ph = await box();
  check(ph.inside && ph.whole && ph.title.includes('New group DM on Discord'), 'the name page on a phone: the title whole', ph);
  check(await p.eval(`document.activeElement?.classList.contains('palette-input')`), 'the name page is about typing: its input has focus');
  await shot('groups-09-phone-name');
  await click('.palette-back-btn');
  await pageIs('group-where');
  check(true, 'the chevron backs out one page');
  await p.eval('history.back()');
  await pageIs('group');
  check((await picked()).length === 3, 'the back button too, the picks kept');

  check(!p.errors.filter((e) => !/status of 429/.test(e)).length, "no page errors but the 429's failed load", p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
