/**
 * Nicknames by account (docs/chats.md, Names), end to end against a multiaccount demo hub in headless Chromium: the
 * demo's nickname for one of Kit's accounts on its tile and its message heads; setting one on another tile from its
 * menu, seeing it in Kit's chat while Kit stays Kit, and taking it away; the identity menu of a message head offering
 * it; no pencil by the name of a chat of several routes; the pencil by a one-route chat's name, which the header and
 * the inbox row follow; the person-level rename answering 400; and no page errors.
 *
 *   DITHER_DEMO_SCENARIO=multiaccount bun packages/hub/src/main.ts --demo --data /tmp/x --port 8577 --web <dist>
 *   bun scripts/verify-nicknames.ts http://127.0.0.1:8577 [/tmp/shots]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8577';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const kit = boot.persons.find((p: any) => p.name === 'Kit' && p.identityIds.length > 3);
if (!kit) throw new Error('no Kit: start the hub with DITHER_DEMO_SCENARIO=multiaccount');
const ident = (handle: string) => boot.identities.find((i: any) => i.handle === handle && kit.identityIds.includes(i.id));
const alt = ident('kit_alt');
const work = ident('kit.work');
// Someone with one account and one DM: their page is that conversation's.
const directs = (pid: string) => boot.conversations.filter((c: any) => c.shape === 'direct' && c.peerPersonId === pid);
const solo = boot.persons.find((p: any) => !p.isSelf && p.identityIds.length === 1 && directs(p.id).length === 1 && !boot.identities.find((i: any) => i.id === p.identityIds[0])?.isBot);
const soloDm = directs(solo.id)[0];

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const at = async (sel: string, pick = '') => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && x.innerText.includes(${JSON.stringify(pick)})); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${pick}`);
  return r;
};
const click = async (sel: string, pick = '', button: 'left' | 'right' = 'left') => {
  const r = await at(sel, pick);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button, clickCount: 1 });
};
const menu = () => p.eval<string[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`);
const pickItem = (label: string) => p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
const escape = () => p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
/** Types into the focused input and presses Enter. */
const typeEnter = async (v: string) => {
  await p.send('Input.insertText', { text: v });
  for (const type of ['keyDown', 'keyUp']) await p.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const clearFocused = () =>
  p.eval(`(() => { const t = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const tile = (handle: string) => p.eval<string>(`[...document.querySelectorAll('.pf-acct')].find((e) => e.innerText.includes(${JSON.stringify(handle)}))?.innerText ?? ''`);
const heads = () => p.eval<string[]>(`[...document.querySelectorAll('.msg-author')].map((e) => e.innerText.trim())`);
const profile = async (pid: string) => {
  await p.goto(`${hub}/#/p/${pid}`);
  await p.until(`!!document.querySelector('.profile-page .pf-hero')`, 15000);
  await Bun.sleep(300);
};
const chat = async (hash: string) => {
  await p.goto(`${hub}/${hash}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(300);
};
const api = (method: string, path: string, body: unknown) => fetch(`${hub}${path}`, { method, body: JSON.stringify(body) });

await p.size(1280, 900);

// ---- Kit's profile: the demo's nickname on a tile, and one set and taken away from another tile's menu.
check(alt?.nickname === 'Kit, raid nights' && kit.nameSource === 'merge', 'the demo gives one of Kit’s accounts a nickname, and Kit stays Kit', [alt?.nickname, kit.name]);
await profile(kit.id);
let t = await tile('kit_alt');
check(t.startsWith('Kit, raid nights') && t.includes('their name: kit (raid)'), 'its tile says the nickname, and the account’s own name beneath it', t.split('\n').slice(0, 3));
if (shots) {
  await p.eval(`[...document.querySelectorAll('.pf-acct')].find((e) => e.innerText.includes('kit_alt')).scrollIntoView({ block: 'center' })`);
  await p.shot(`${shots}/1-tile-with-nickname.png`);
}
await click('.pf-acct', 'kit.work');
await p.eval(`[...document.querySelectorAll('.pf-acct')].find((e) => e.innerText.includes('kit.work')).querySelector('button[aria-label^="More for"]').click()`);
await Bun.sleep(150);
let items = await menu();
check(items.includes('Set Nickname…') && !items.includes('Remove Nickname'), 'a tile’s menu: Set Nickname…', items);
await pickItem('Set Nickname…');
await p.until(`document.activeElement?.classList.contains('pf-acct-nick-input')`, 3000);
await typeEnter('Kit at work');
await p.until(`[...document.querySelectorAll('.pf-acct')].some((e) => e.innerText.startsWith('Kit at work'))`, 5000).catch(() => {});
t = await tile('kit.work');
check(t.startsWith('Kit at work') && t.includes('their name: Kit Okafor'), 'set inline on the tile, it shows at once with the account’s own name beneath', t.split('\n').slice(0, 3));
check((await p.eval<string>(`document.querySelector('.pf-title h1')?.innerText ?? ''`)).startsWith('Kit'), 'Kit is still Kit: the name was another account’s');

// ---- Kit's chat: the heads follow, the identity menu has the entries, and the name has no pencil.
const kitDm = boot.conversations.find((c: any) => c.shape === 'direct' && c.participantIds.includes(work.id));
await chat(`#/inbox/c/${kitDm.id}`);
let h = await heads();
check(h.includes('Kit at work') && h.includes('Kit, raid nights'), 'Kit’s chat names those accounts’ messages by your nicknames', [...new Set(h)]);
check(!(await p.eval<boolean>(`!!document.querySelector('.conv-head .pair-nick-edit')`)), 'a chat of several routes has no pencil by its name');
check((await p.eval<string>(`document.querySelector('.conv-head .conv-head-name')?.innerText ?? ''`)) === 'Kit', 'its name is Kit’s, made of the accounts’');
if (shots) {
  await p.eval(`[...document.querySelectorAll('.msg-author')].find((e) => e.innerText.includes('Kit at work'))?.scrollIntoView({ block: 'center' })`);
  await p.shot(`${shots}/2-chat-nicknamed-head.png`);
}
await click('.msg-author', 'Kit at work', 'right');
await Bun.sleep(200);
items = await menu();
check(items.includes('Change Nickname…') && items.includes('Remove Nickname'), 'a message head’s menu: Change Nickname… and Remove Nickname', items);
await escape();

await profile(kit.id);
await p.eval(`[...document.querySelectorAll('.pf-acct')].find((e) => e.innerText.includes('kit.work')).querySelector('button[aria-label^="More for"]').click()`);
await Bun.sleep(150);
await pickItem('Remove Nickname');
await p.until(`[...document.querySelectorAll('.pf-acct')].some((e) => e.innerText.startsWith('Kit Okafor'))`, 5000).catch(() => {});
t = await tile('kit.work');
check(t.startsWith('Kit Okafor') && !t.includes('their name'), 'Remove Nickname gives the tile its own name back', t.split('\n').slice(0, 2));
await chat(`#/inbox/c/${kitDm.id}`);
h = await heads();
check(!h.includes('Kit at work') && h.includes('Kit Okafor'), 'and the heads follow', [...new Set(h)]);

// ---- One route: the pencil by the name; the header and the inbox row follow.
await chat(`#/inbox/c/${soloDm.id}`);
const row = () => p.eval<string>(`[...document.querySelectorAll('.sidebar [data-row]')].filter((e) => e.dataset.row.includes(${JSON.stringify(soloDm.id)})).map((e) => e.innerText).join(' | ')`);
check((await row()).includes(solo.name), `${solo.name} has a row in the inbox`, (await row()).slice(0, 80));
check(await p.eval<boolean>(`!!document.querySelector('.conv-head .pair-nick-edit')`), `${solo.name}’s one-route chat has the pencil`);
await click('.conv-head .pair-nick-edit');
await p.until(`document.activeElement?.classList.contains('pair-nick-input')`, 3000);
await typeEnter('Buddy');
await p.until(`document.querySelector('.conv-head .conv-head-name')?.innerText === 'Buddy'`, 5000).catch(() => {});
check((await p.eval<string>(`document.querySelector('.conv-head .conv-head-name')?.innerText ?? ''`)) === 'Buddy', 'the header says the nickname');
const crumb = await p.eval<string>(`[...document.querySelectorAll('.conv-head .crumb')].at(-1)?.innerText ?? ''`);
check(crumb === 'Buddy', 'and so does the crumb under it', crumb);
const r1 = await row();
check(r1.includes('Buddy'), 'the inbox row follows', r1.slice(0, 80));
const sb = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
check(sb.persons.find((x: any) => x.id === solo.id)?.name === 'Buddy', 'their person is named by it on the hub', sb.persons.find((x: any) => x.id === solo.id)?.name);
if (shots) await p.shot(`${shots}/3-one-route-nickname.png`);
await click('.conv-head .pair-nick-edit');
await p.until(`document.activeElement?.classList.contains('pair-nick-input')`, 3000);
await clearFocused();
await typeEnter('');
await p.until(`document.querySelector('.conv-head .conv-head-name')?.innerText === ${JSON.stringify(solo.name)}`, 5000).catch(() => {});
const back = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
check(
  (await p.eval<string>(`document.querySelector('.conv-head .conv-head-name')?.innerText ?? ''`)) === solo.name && back.persons.find((x: any) => x.id === solo.id)?.name === solo.name && !back.identities.find((x: any) => x.id === solo.identityIds[0])?.nickname,
  'left empty, the nickname goes and their own name comes back',
  solo.name,
);

// ---- The person-level rename is gone.
const old1 = await api('PATCH', `/api/persons/${kit.id}`, { name: 'Kitty' });
const old2 = await api('PATCH', `/api/chats/person:${kit.id}`, { name: 'Kitty' });
const said = ((await old1.json()) as any).error as string;
check(old1.status === 400 && old2.status === 400 && said.includes('/api/identities/:id'), 'PATCH a person’s name answers 400 and names the new call', [old1.status, old2.status, said]);

// ---- A phone: the tile still reads.
await p.size(390, 844, true);
await profile(kit.id);
t = await tile('kit_alt');
check(t.startsWith('Kit, raid nights') && t.includes('their name'), 'on a phone too', t.split('\n').slice(0, 2));
if (shots) {
  await p.eval(`[...document.querySelectorAll('.pf-acct')].find((e) => e.innerText.includes('kit_alt')).scrollIntoView({ block: 'center' })`);
  await p.shot(`${shots}/4-phone-tile.png`);
}

check(!p.errors.length, 'no page errors', p.errors.slice(0, 5));
await close();
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
