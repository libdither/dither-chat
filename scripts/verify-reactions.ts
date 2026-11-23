/**
 * The reaction picker and the add button (docs/reactions.md), end to end against a demo hub in headless Chromium:
 * Discord's layout (category rail, named emoji along the bottom), emoji drawn whole rather than clipped, hovering and
 * scrolling leaving the grid untouched, and on Signal, where one reaction per person is kept, the add button and the
 * picker saying a pick replaces yours, and a pick doing so. Then when each reacted (docs/reactions.md "When"): a pill's
 * tooltip with a line per person, the list of who reacted with each time and who took theirs back, Message history's
 * reactions made and taken back, and on Discord, times marked "~" (when the hub heard) with no note.
 *
 *   bun scripts/verify-reactions.ts http://127.0.0.1:8482 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this reacts to messages.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8482';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const group = (network: string) => boot.conversations.find((c: any) => c.network === network && c.shape === 'group')?.id;
const discord = group('discord');
const signal = group('signal');
if (!discord || !signal) throw new Error('the demo world has no Discord or Signal group');
const named = (name: string) => boot.conversations.find((c: any) => c.name === name)?.id;
const climb = named('Climbing crew 🧗');
const raid = named('weekend raid');
if (!climb || !raid) throw new Error('the demo world has no Climbing crew or weekend raid');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const at = (sel: string, idx = -1) =>
  p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getBoundingClientRect().width > 0).at(${idx}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 14) }; })()`,
  );
const move = async (sel: string, idx = -1) => {
  const r = await at(sel, idx);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  return r;
};
const click = async (sel: string, idx = -1) => {
  const r = await move(sel, idx);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const openPicker = async () => {
  await move('.msg:not(.system)');
  await Bun.sleep(250);
  await click('.msg-actions button[aria-label="More reactions"]');
  await p.until(`!!document.querySelector('.emoji-picker .ep-emoji')`, 8000);
  await Bun.sleep(300);
};
const escape = () => p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

try {
  await p.size(1280, 860);
  await p.goto(`${hub}/#/c/${discord}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(500);

  // Discord's layout.
  await openPicker();
  const rail = await p.eval<string[]>(`[...document.querySelectorAll('.ep-rail-btn')].map((b) => b.title)`);
  check(rail[0] === 'Frequently used' && rail.includes('Flags') && rail.includes('This server'), 'a rail of categories: frequent, each server, then Unicode', rail);
  await move('.ep-emoji', 30);
  await Bun.sleep(150);
  const foot = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/^\S+:[a-z0-9_+-]+:$/.test(foot.trim()), 'the emoji under the pointer is named along the bottom', foot);
  await click('.ep-rail-btn[title="Flags"]', 0);
  await Bun.sleep(250);
  check((await p.eval(`document.querySelector('.ep-rail-btn.on')?.title`)) === 'Flags', 'the rail jumps to a category and marks it');
  if (shots) await p.shot(`${shots}/reactions-discord.png`);

  // Drawn whole: the glyph inside its cell, nothing clipping it vertically.
  const clip = await p.eval<{ over: number; overflow: string }[]>(`[...document.querySelectorAll('.ep-emoji')].slice(20, 60).map((b) => { const s = b.querySelector('.emoji-text'); const r = document.createRange(); r.selectNodeContents(s); const g = r.getBoundingClientRect(); const c = b.getBoundingClientRect(); return { over: Math.max(c.top - g.top, g.bottom - c.bottom), overflow: getComputedStyle(s).overflowY }; })`);
  check(clip.length > 0 && clip.every((c) => c.over <= 0 && c.overflow === 'visible'), 'emoji are drawn whole inside their cells', clip.slice(0, 3));

  // No flicker: hovering and scrolling change the footer and the rail, never the grid's cells.
  const churn = await p.eval<Record<string, number>>(`new Promise(async (res) => {
    const grid = document.querySelector('.ep-scroll');
    const where = {};
    const mo = new MutationObserver((ms) => { for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; const k = el.closest('.ep-foot') ? 'foot' : el.closest('.ep-rail') ? 'rail' : el.closest('.ep-emoji') ? 'cells' : 'other'; where[k] = (where[k] ?? 0) + 1; } });
    const picker = document.querySelector('.emoji-picker');
    if (!picker) return res({ closed: 1 });
    mo.observe(picker, { subtree: true, childList: true, attributes: true, characterData: true });
    const cells = [...document.querySelectorAll('.ep-emoji')];
    for (let i = 30; i < 80; i++) { cells[i].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); await new Promise((r) => requestAnimationFrame(r)); }
    for (let i = 0; i <= 20; i++) { grid.scrollTop = i * 400; await new Promise((r) => requestAnimationFrame(r)); }
    await new Promise((r) => setTimeout(r, 100));
    mo.disconnect();
    res(where);
  })`);
  check(!churn.cells && !churn.other && (churn.foot ?? 0) > 0, 'hovering and scrolling change only the footer and the rail', churn);
  await escape();
  await Bun.sleep(200);
  const plain = await p.eval<string | null>(`[...document.querySelectorAll('.msg-actions button[aria-label="More reactions"]')].at(-1)?.className ?? null`);
  check(plain !== null && !plain.includes('swap'), 'on Discord the add button adds', plain);

  // Signal keeps one reaction per person.
  await p.goto(`${hub}/#/c/${signal}`);
  await p.until(`document.querySelectorAll('.msg').length > 1`, 15000);
  await Bun.sleep(500);
  const last = (await fetch(`${hub}/api/conversations/${signal}/messages?limit=1`).then((r) => r.json())) as any;
  const mid = last.messages.at(-1).id;
  const reacted = await fetch(`${hub}/api/messages/${mid}/react`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '👍' }) });
  check(reacted.ok, 'reacted 👍 on Signal');
  await p.until(`[...document.querySelectorAll('.reaction.mine')].some((r) => r.textContent.includes('👍'))`, 8000);
  await move('.msg:not(.system)');
  await Bun.sleep(300);
  const row = await p.eval<{ cls: string; title: string }[]>(`[...document.querySelectorAll('.msg-actions button')].filter((b) => b.getBoundingClientRect().width).slice(0, 5).map((b) => ({ cls: b.className, title: b.title }))`);
  const add = row.find((b) => b.cls.includes('swap'));
  check(add && /keeps one per person/.test(add.title), 'on Signal, with a reaction of yours, the add button shows the swap icon', add);
  check(row.some((b) => b.cls.includes('on') && b.title.includes('Take back your 👍')), 'your reaction is marked in the quick row', row.map((b) => b.title));
  const pill = await p.eval<string | null>(`[...document.querySelectorAll('.reaction.add')].at(-1)?.className ?? null`);
  check(pill?.includes('swap'), 'the add button beside the pills swaps too', pill);
  if (shots) await p.shot(`${shots}/reactions-signal-row.png`);
  await openPicker();
  const idle = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/keeps one reaction per person: a pick replaces your 👍/.test(idle), 'the picker says a pick replaces yours', idle);
  const joy = await p.eval<number>(`[...document.querySelectorAll('.ep-emoji')].findIndex((b) => b.getAttribute('aria-label') === ':joy:')`);
  await move('.ep-emoji', joy);
  await Bun.sleep(150);
  const hover = await p.eval<string>(`document.querySelector('.ep-foot')?.textContent ?? ''`);
  check(/:joy:.*replaces/.test(hover), 'hovering another emoji says it replaces yours', hover);
  if (shots) await p.shot(`${shots}/reactions-signal-picker.png`);
  await click('.ep-emoji', joy);
  await Bun.sleep(1200);
  const after = ((await fetch(`${hub}/api/conversations/${signal}/messages?limit=1`).then((r) => r.json())) as any).messages.at(-1).reactions.filter((r: any) => r.identityIds.length && r.key);
  const mine = after.filter((r: any) => r.identityIds.some((i: string) => boot.accounts.some((a: any) => a.selfIdentityId === i)));
  check(mine.length === 1 && mine[0].key === '😂', 'picking 😂 replaced your 👍', mine.map((r: any) => r.key));

  // When each reacted (docs/reactions.md "When"). The pill of a message found by its words, marked for move().
  const pillOf = (words: string, key: string) =>
    p.eval<boolean>(`(() => {
      document.querySelectorAll('[data-vr]').forEach((e) => e.removeAttribute('data-vr'));
      const m = [...document.querySelectorAll('.msg')].find((x) => x.textContent.includes(${JSON.stringify(words)}));
      const r = m && [...m.querySelectorAll('.reaction')].find((x) => x.textContent.includes(${JSON.stringify(key)}));
      if (r) r.setAttribute('data-vr', '1');
      return !!r;
    })()`);
  const tooltip = async () => {
    await p.until(`!!document.querySelector('.tooltip.shown')`, 4000).catch(() => {});
    return p.eval<string>(`document.querySelector('.tooltip.shown')?.innerText ?? ''`);
  };
  const openWho = async () => {
    // Who reacted is View Reactions in the message's menu; a right-click on the pill opens its history instead.
    await p.eval(`(() => { const m = document.querySelector('[data-vr]').closest('.msg'); const b = m.querySelector('.msg-body').getBoundingClientRect(); m.querySelector('.msg-body').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 5, clientY: b.y + 5 })); })()`);
    await p.until(`[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent.includes('View Reactions'))`, 4000);
    await p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('View Reactions')).click()`);
    await p.until(`!!document.querySelector('.cm-sub [role="menuitem"]')`, 4000);
    await p.eval(`(() => { const k = document.querySelector('[data-vr] .emoji-text, [data-vr] .emoji-img'); const t = k.alt || k.textContent; [...document.querySelectorAll('.cm-sub [role="menuitem"]')].find((i) => i.textContent.includes(t)).click(); })()`);
    await p.until(`!!document.querySelector('.reactors .reactor')`, 5000);
    await Bun.sleep(600);
    return p.eval<{ rows: { name: string; when: string; title: string; past: string; gone: boolean }[]; sub: string; notes: number }>(`(() => {
      const box = document.querySelector('.reactors');
      return {
        rows: [...box.querySelectorAll('.reactor')].map((r) => ({ name: r.querySelector('.reactor-who > span')?.textContent ?? '', when: r.querySelector('.reactor-when')?.textContent ?? '', title: r.querySelector('.reactor-when')?.title ?? '', past: r.querySelector('.reactor-past')?.textContent ?? '', gone: r.classList.contains('gone') })),
        sub: box.querySelector('.reactors-sub')?.textContent ?? '',
        notes: box.querySelectorAll('p').length,
      };
    })()`);
  };
  const time = /\d{1,2}:\d{2}/;

  await p.goto(`${hub}/#/c/${climb}`);
  await p.until(`[...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('three sizes too big'))`, 15000);
  await Bun.sleep(500);
  check(await pillOf('three sizes too big', '😂'), "Sam's message has a 😂 from three people");
  await move('[data-vr]');
  const tip = await tooltip();
  const tipLines = tip.split('\n').filter(Boolean);
  check(tipLines.length >= 4 && ['Priya', 'Alice', 'Theo'].every((n) => tipLines.some((l) => l.startsWith(n) && time.test(l))) && !/~/.test(tip), "hovering a pill shows who reacted and each one's time, Signal's own", tipLines);
  if (shots) await p.shot(`${shots}/when-tooltip-signal.png`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  // A right-click on a pill opens the message's history on its reactions, with a way to all of it.
  await p.eval(`(() => { const r = document.querySelector('[data-vr]'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 5, clientY: b.y + 5 })); })()`);
  await p.until(`!!document.querySelector('.mh-pop .mh-row')`, 5000);
  const pillHistory = await p.eval<{ head: string; rows: string[]; menu: boolean }>(`({ head: document.querySelector('.mh-pop .mh-bar')?.innerText ?? '', rows: [...document.querySelectorAll('.mh-pop .mh-row .mh-what')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim()), menu: !!document.querySelector('.cm') })`);
  check(/Reactions/i.test(pillHistory.head) && /All history/i.test(pillHistory.head) && pillHistory.rows.some((r) => /reacted/.test(r)) && !pillHistory.menu, 'a right-click on a pill opens its reactions history, not a menu', pillHistory);
  await escape();
  await Bun.sleep(200);
  const laughs = await openWho();
  const mei = laughs.rows.find((r) => r.name.startsWith('Mei'));
  check(laughs.sub === 'Taken back' && mei?.gone && /^took back \d/.test(mei.when) && /^added \d/.test(mei.past), 'who took theirs back is listed under Taken back, with when they added it', laughs.rows);
  if (shots) await p.shot(`${shots}/when-who-taken-back.png`);
  await escape();
  await Bun.sleep(200);

  // Sam's 😢 on the pinned message: made, taken back, made again; Alice's once.
  check(await pillOf('Mesa is open till 10', '😢'), 'the pinned message has a 😢');
  const who = await openWho();
  const sam = who.rows.find((r) => r.name.startsWith('Sam'));
  check(sam && time.test(sam.when) && /^added .*· took back /.test(sam.past), "the list of who reacted: Sam's time now, and under it when they added and took it back", who.rows);
  check(who.rows.some((r) => r.name.startsWith('Alice') && time.test(r.when) && !r.past), "…and Alice's time, with nothing before it", who.rows);
  check(!who.notes && who.rows.every((r) => !r.when.startsWith('~')), 'no note and no "~": Signal says when', who);
  if (shots) await p.shot(`${shots}/when-who-signal.png`);
  await escape();
  await Bun.sleep(200);

  // Message history: reactions made and taken back, in order.
  await p.eval(`(() => { const m = [...document.querySelectorAll('.msg')].find((x) => x.textContent.includes('Mesa is open till 10')); const b = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.x + 40, clientY: b.y + 8 })); })()`);
  await p.until(`[...document.querySelectorAll('[role="menuitem"]')].some((i) => i.textContent.includes('Message History'))`, 4000);
  await p.eval(`[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('Message History')).click()`);
  await p.until(`!!document.querySelector('.mh-pop .mh-row')`, 5000);
  await Bun.sleep(300);
  const lines = await p.eval<string[]>(`[...document.querySelectorAll('.mh-pop .mh-row .mh-what')].filter((e) => !/sent it/.test(e.innerText)).map((e) => e.innerText.replace(/\s+/g, ' ').trim())`);
  const order = lines.map((l) => (l.includes('pinned') ? 'pin' : /^Sam\S* ?\S* reacted/.test(l) ? 'sam+' : /^Sam\S* ?\S* took back/.test(l) ? 'sam-' : /^Alice\S* ?\S* reacted/.test(l) ? 'alice+' : '?'));
  check(order.join() === 'sam+,sam-,pin,alice+,sam+' || order.join() === 'pin,sam+,sam-,alice+,sam+', 'Message history: Sam reacted, took it back, Alice reacted, Sam reacted again, each with its time', lines);
  if (shots) await p.shot(`${shots}/when-history-signal.png`);
  await escape();
  await Bun.sleep(300);

  // Discord gives no times: "~" when the hub heard, and no note; Theo's, there before the hub saw it, has none.
  await p.goto(`${hub}/#/c/${raid}`);
  await p.until(`[...document.querySelectorAll('.msg')].some((m) => m.textContent.includes("who's in for saturday"))`, 15000);
  await Bun.sleep(500);
  check(await pillOf("who's in for saturday", '🙋'), "Ravi's message has a 🙋");
  await move('[data-vr]');
  const dtip = (await tooltip()).split('\n').filter(Boolean);
  check(dtip.some((l) => /^Ravi · ~\d/.test(l)) && dtip.includes('Theo') && !dtip.some((l) => /doesn't say|hub/.test(l)), 'on Discord the tooltip marks the time "~", with no note', dtip);
  if (shots) await p.shot(`${shots}/when-tooltip-discord.png`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  const dwho = await openWho();
  check(dwho.rows.some((r) => r.name === 'Ravi' && /^~\d/.test(r.when) && /when the hub heard/.test(r.title) && /^added ~\d.*took back ~\d/.test(r.past)), "the list: Ravi's time is ~ when the hub heard (its title says so), after they took one back", dwho.rows);
  check(dwho.rows.some((r) => r.name === 'Theo' && !r.when), "…Theo's has no time", dwho.rows);
  check(!dwho.notes, 'no note under the list', dwho);
  if (shots) await p.shot(`${shots}/when-who-discord.png`);
  await escape();
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
