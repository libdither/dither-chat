/**
 * Message history (docs/history.md), end to end against a demo hub in headless Chromium: a deleted and a disappeared
 * message kept as collapsed lines that open; an edited message's earlier versions; a pinned message marked, a reaction
 * taken back, read ticks and who read it; a group's History card with a description change, a member joining and a
 * role given; a person's status changing; hiding kept messages completely from Settings; a network turned off; and
 * forgetting what was kept.
 *
 *   bun scripts/verify-history.ts http://127.0.0.1:8499 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this changes settings and forgets things.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8499';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const climb = boot.conversations.find((c: any) => c.name === 'Climbing crew 🧗')?.id;
if (!climb) throw new Error('the demo world lacks Climbing crew');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const put = (body: unknown) => fetch(`${hub}/api/retention`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify(body) }).then((r) => r.json()) as Promise<any>;

const { page: p, close } = await launch();
const lines = () => p.eval<string[]>(`[...document.querySelectorAll('.msg-gone-line')].map((b) => b.textContent.trim())`);
try {
  await p.size(1280, 900);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(500);
  const gone = await lines();
  check(gone.some((l) => l.startsWith('Deleted message')) && gone.some((l) => l.startsWith('Disappeared message')), 'deleted and disappeared messages as collapsed lines', gone);
  check(!(await p.eval<string>(`document.querySelector('.timeline')?.innerText ?? document.body.innerText`)).includes('wrong chat lol'), 'their words hidden until opened');
  await p.eval(`[...document.querySelectorAll('.msg-gone-line')].find((b) => b.textContent.startsWith('Deleted')).click()`);
  await Bun.sleep(200);
  check((await p.eval<string>(`document.querySelector('.msg-gone.open')?.innerText ?? ''`)).includes('wrong chat lol, ignore this'), 'opening one shows what it said');
  if (shots) await p.shot(`${shots}/history-chat.png`);

  await p.eval(`document.querySelector('button.msg-edited.link').click()`);
  await p.until(`document.querySelectorAll('.edit-version').length >= 2`, 5000);
  const versions = await p.eval<string[]>(`[...document.querySelectorAll('.edit-version .edit-body')].map((s) => s.textContent)`);
  check(versions[0] === 'meet at 6' && versions.at(-1) === 'meet at 6:30, traffic', '(edited) lists the versions, oldest first', versions);
  if (shots) await p.shot(`${shots}/history-edits.png`);

  // Pins, receipts and the message's whole history.
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.eval(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await Bun.sleep(200);
  check(await p.eval<boolean>(`!!document.querySelector('.msg-pin')`), 'a pinned message is marked');
  const ticks = await p.eval<{ cls: string; title: string } | null>(`(() => { const t = document.querySelector('.msg-ticks'); return t ? { cls: t.className, title: t.title } : null; })()`);
  check(ticks?.cls.includes('read') && /Read by 2/.test(ticks.title), 'your message has read ticks: read by two', ticks);
  await p.eval(`document.querySelector('.msg-ticks').click()`);
  await p.until(`!!document.querySelector('.modal .msg-history section')`, 5000);
  const hist = await p.eval<string>(`document.querySelector('.modal .msg-history').innerText`);
  check(/READ BY 2/i.test(hist) && hist.includes('Alice') && hist.includes('Priya'), 'its history lists who read it', hist.split('\n').slice(0, 5));
  await p.eval(`document.querySelector('.modal-backdrop')?.click()`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await Bun.sleep(300);
  const pinned = await p.eval<string>(`document.querySelector('.msg-pin')?.closest('.msg')?.id ?? ''`);
  const evs = (await fetch(`${hub}/api/messages/${pinned.slice(2)}/history`).then((r) => r.json())) as any;
  check(evs.events.map((e: any) => e.kind).join() === 'pin,unreact', 'the pinned one: pinned, and a reaction taken back', evs.events.map((e: any) => e.kind));

  // The group's History card.
  await p.goto(`${hub}/#/about/c/${climb}`);
  await p.until(`!!document.querySelector('.hist-list')`, 10000);
  const card = await p.eval<string>(`[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith('History'))?.innerText ?? ''`);
  check(card.includes('Mei') && card.includes('joined') && card.includes('Description changed'), 'History: a member joined, the description changed', card.split('\n').slice(0, 6));
  check(/Sam Rivera\s*was given\s*Admin\s*by\s*(PR\s*)?Priya/.test(card.replace(/\n/g, ' ')), 'a role given, and by whom', card.split('\n').slice(0, 12));
  await p.eval(`[...document.querySelectorAll('.hist-line')].find((b) => b.textContent.includes('Description changed')).click()`);
  await Bun.sleep(150);
  check((await p.eval<string>(`document.querySelector('.hist-diff .was')?.textContent ?? ''`)) === 'Tuesdays at Mesa', 'a description change shows before and after');
  if (shots) await p.shot(`${shots}/history-card.png`);

  // A person's History: their status changed.
  const alice = boot.persons.find((x: any) => x.name === 'Alice Chen');
  await p.goto(`${hub}/#/p/${alice.id}`);
  await p.until(`!!document.querySelector('.hist-list')`, 10000);
  const ah = await p.eval<string>(`[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith('History'))?.innerText ?? ''`);
  check(ah.includes('out climbing') && ah.includes('on the wall, back at 8') && !/→ 🧗\n/.test(ah), 'a person’s History shows their status changing, once', ah.split('\n').slice(0, 6));

  // Settings: hidden completely.
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-history')`, 10000);
  await p.eval(`[...document.querySelectorAll('#set-history .seg .chip-btn')].find((b) => b.textContent.includes('Hidden')).click()`);
  await Bun.sleep(400);
  check((await fetch(`${hub}/api/retention`).then((r) => r.json()) as any).show === 'hidden', 'Settings hides them completely');
  if (shots) await p.shot(`${shots}/history-settings.png`);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(400);
  check((await lines()).length === 0 && !(await p.eval<boolean>(`[...document.querySelectorAll('.msg-body.deleted')].length > 0`)), 'and the chat no longer shows them');

  // A network turned off, through the table's checkbox.
  await put({ show: 'collapsed' });
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('.hist-table')`, 10000);
  await p.eval(`(() => { const row = [...document.querySelectorAll('.hist-table tr.hist-net')].find((r) => r.textContent.includes('Signal')); row.querySelector('td input').click(); })()`);
  await Bun.sleep(400);
  const r = (await fetch(`${hub}/api/retention`).then((x) => x.json())) as any;
  check(r.sources.signal?.deleted === false, 'Signal’s deleted messages turned off on their own', r.sources);

  // Forget what was kept.
  const erased = (await fetch(`${hub}/api/retention/erase`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ what: 'deleted' }) }).then((x) => x.json())) as any;
  check(erased.erased >= 1, 'forgetting kept deleted messages', erased);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(400);
  const after = await lines();
  check(!after.some((l) => l.startsWith('Deleted')) && after.some((l) => l.startsWith('Disappeared')), 'the deleted one is now a plain “Message deleted”; the disappeared one stays', after);
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
