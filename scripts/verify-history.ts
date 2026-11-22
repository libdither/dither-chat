/**
 * Message history (docs/history.md), end to end against a demo hub in headless Chromium: a deleted and a disappeared
 * message kept as collapsed lines that open; an edited message's earlier versions, the words its last edit put in
 * underlined and opening its edits, and its history as one list, latest at the bottom; a pinned message marked, a
 * reaction taken back, read ticks and who read it; a group's History card with a description change, a member joining and a
 * role given; a person's Activity section with their status changing and their presence over time; hiding kept messages completely from Settings; a network turned off; and
 * forgetting what was kept.
 *
 *   bun scripts/verify-history.ts http://127.0.0.1:8499 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo --adversarial) with its own data dir: this changes settings and forgets
 * things. Without --adversarial nothing deleted or disappeared is kept, which scripts/verify-adversarial.ts checks.
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
const lines = () => p.eval<string[]>(`[...document.querySelectorAll('.msg-gone .msg-gone-mark')].map((b) => b.textContent.trim())`);
try {
  await p.size(1280, 900);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(500);
  const gone = await lines();
  check(gone.some((l) => l.startsWith('Deleted')) && gone.some((l) => l.startsWith('Disappeared')), 'deleted and disappeared messages marked as such', gone);
  check((await p.eval<string>(`[...document.querySelectorAll('.msg-gone')].map((g) => g.innerText).join('\\n')`)).includes('wrong chat lol, ignore this'), 'shown in full, what it said with it');
  if (shots) await p.shot(`${shots}/history-chat.png`);

  // Priya's message: what the edit put in is underlined in the chat.
  const priya = `[...document.querySelectorAll('.msg')].find((m) => m.textContent.includes('meet at 6:30'))`;
  check((await p.eval<string>(`[...(${priya}).querySelectorAll('.msg-changed')].map((s) => s.textContent).join('|')`)) === '6:30, traffic', 'the words the edit put in are underlined');
  await p.eval(`(${priya}).querySelector('button.msg-edited.link').click()`);
  await p.until(`document.querySelectorAll('.mh-pop .mh-row').length >= 2`, 5000);
  const edits = await p.eval<string[]>(`[...document.querySelectorAll('.mh-pop .mh-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
  check(edits.length === 2 && /sent it meet at 6\b/.test(edits[0]) && /edited it meet at 6 ?6:30, traffic/.test(edits[1]), '(edited) opens its edits, oldest first: as sent, then the edit as words out and in', edits);
  if (shots) await p.shot(`${shots}/history-edits.png`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.until(`!document.querySelector('.mh-pop')`, 3000);

  // Your message, edited twice: a click on its underlined words opens its edits, and from there all of its history.
  const mine = `[...document.querySelectorAll('.msg')].find((m) => m.textContent.includes('I can drive'))`;
  check((await p.eval<string>(`[...(${mine}).querySelectorAll('.msg-changed')].map((s) => s.textContent).join('|')`)) === 'from the gym, room for 3', 'only the last edit is underlined');
  await p.eval(`(${mine}).querySelector('.msg-changed').click()`);
  await p.until(`!!document.querySelector('.mh-pop .mh-bar .link') && document.querySelectorAll('.mh-pop .mh-row').length > 0`, 5000);
  check((await p.eval<number>(`document.querySelectorAll('.mh-pop .mh-row').length`)) === 3, 'its edits: sent and two edits');
  await p.eval(`document.querySelector('.mh-pop .mh-bar .link').click()`);
  await p.until(`document.querySelectorAll('.mh-pop .mh-row').length > 3`, 5000);
  const all = await p.eval<string[]>(`[...document.querySelectorAll('.mh-pop .mh-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())`);
  const kinds = all.map((l) => (/sent it/.test(l) ? 'sent' : /edited it/.test(l) ? 'edit' : /^Delivered/.test(l) ? 'delivered' : /^Read by/.test(l) ? 'read' : /reacted/.test(l) ? 'react' : '?'));
  check(kinds.join() === 'sent,delivered,react,read,edit,react,edit', 'All history: sent, delivered, a reaction, both reads in one row, an edit, a reaction, the last edit', all);
  check(await p.eval<boolean>(`(() => { const l = document.querySelector('.mh-pop .mh-list'); return l.scrollHeight <= l.clientHeight + 1 || l.scrollTop + l.clientHeight >= l.scrollHeight - 2; })()`), 'scrolled to the latest, at the bottom');
  if (shots) await p.shot(`${shots}/history-all.png`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.until(`!document.querySelector('.mh-pop')`, 3000);

  // Pins, receipts and the message's whole history.
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await p.eval(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await Bun.sleep(200);
  check(await p.eval<boolean>(`!!document.querySelector('.msg-pin')`), 'a pinned message is marked');
  const ticks = await p.eval<{ cls: string; title: string } | null>(`(() => { const t = document.querySelector('.msg-ticks'); return t ? { cls: t.className, title: t.title } : null; })()`);
  check(ticks?.cls.includes('read') && /Read by 2/.test(ticks.title), 'your message has read ticks: read by two', ticks);
  await p.eval(`document.querySelector('.msg-ticks').click()`);
  await p.until(`!!document.querySelector('.mh-pop .mh-row')`, 5000);
  const hist = await p.eval<string>(`document.querySelector('.mh-pop .mh-list').innerText`);
  check(/Read by\s+Alice Chen and Priya/.test(hist), 'its history lists who read it', hist.split('\n').slice(0, 8));
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

  // A person's Activity section: the status at the top, then its history and their presence over time, each opening.
  const alice = boot.persons.find((x: any) => x.name === 'Alice Chen');
  await p.goto(`${hub}/#/p/${alice.id}`);
  await p.until(`!!document.querySelector('.pf-activity-card .presence-dot')`, 10000);
  const current = await p.eval<string>(`document.querySelector('.pf-activity-card .pf-status')?.innerText ?? ''`);
  const hero = await p.eval<string>(`document.querySelector('.pf-hero .pf-status')?.innerText ?? ''`);
  check(current.includes('🧗') && hero.includes(current.replace('🧗', '').replace(/since.*$/s, '').trim()), 'the current status at the top of Activity (the one in the hero)', { hero, current });
  check(await p.eval<boolean>(`!document.querySelector('.pf-status-history').open && !document.querySelector('.pf-presence-history').open`), 'its status and presence history start collapsed');
  await p.eval(`document.querySelector('.pf-status-history summary').click(); document.querySelector('.pf-presence-history summary').click()`);
  await Bun.sleep(200);
  const st = await p.eval<string>(`document.querySelector('.pf-activity-card').innerText`);
  check(st.includes('since') && /STATUS HISTORY/i.test(st) && st.includes('out climbing') && st.includes('on the wall, back at 8') && !/→ 🧗\n/.test(st), 'opened: the current status, and its history once', st.split('\n').slice(0, 8));
  const pres = await p.eval<string[]>(`document.querySelector('.pf-presence-history .hist-list')?.innerText.split('\\n').filter(Boolean) ?? []`);
  check(/PRESENCE HISTORY/i.test(st) && /Do not disturb on desktop and mobile/.test(st) && pres.some((l) => /Offline for 2h/.test(l)) && pres.some((l) => /Idle on desktop for 30m/.test(l)), 'presence now, and each stretch with how long', pres);
  const ah = await p.eval<string>(`[...document.querySelectorAll('.pf-card')].find((c) => c.querySelector('h3')?.textContent.startsWith('History'))?.innerText ?? ''`);
  check(!ah.includes('out climbing') && !ah.includes('Presence'), 'the History card no longer lists statuses or presence', ah.split('\n').slice(0, 6));
  if (shots) await p.shot(`${shots}/history-status.png`);

  // Settings: hidden completely.
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-adversarial .adv-body')`, 10000);
  await p.eval(`[...document.querySelectorAll('#set-adversarial .seg .chip-btn')].find((b) => b.textContent.includes('Hidden')).click()`);
  await Bun.sleep(400);
  check((await fetch(`${hub}/api/retention`).then((r) => r.json()) as any).show === 'hidden', 'Settings hides them completely');
  if (shots) await p.shot(`${shots}/history-settings.png`);
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(400);
  check((await lines()).length === 0 && !(await p.eval<boolean>(`[...document.querySelectorAll('.msg-body.deleted')].length > 0`)), 'and the chat no longer shows them');

  // Shown everywhere but hidden in one chat, from the chat's page.
  await put({ show: 'shown' });
  await p.goto(`${hub}/#/about/c/${climb}`);
  await p.until(`[...document.querySelectorAll('.pf-card')].some((c) => c.textContent.includes('Kept messages'))`, 10000);
  await p.eval(`(() => { const s = [...document.querySelectorAll('.pf-card')].find((c) => c.textContent.includes('Kept messages')).querySelector('select'); s.value = 'hidden'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await Bun.sleep(400);
  check(((await fetch(`${hub}/api/retention`).then((r) => r.json())) as any).showIn[climb] === 'hidden', 'the chat page hides them in this chat');
  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`document.querySelectorAll('.msg').length > 3`, 15000);
  await Bun.sleep(400);
  check((await lines()).length === 0, 'and the chat no longer shows them');
  await put({ showIn: { [climb]: null } });

  // A network turned off, through the table's checkbox (asked first).
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-adversarial .hist-table')`, 10000);
  await p.eval(`window.confirm = () => true`);
  await p.eval(`(() => { const row = [...document.querySelectorAll('#set-adversarial .hist-table tr.hist-net')].find((r) => r.textContent.includes('Signal')); row.querySelector('td input').click(); })()`);
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
