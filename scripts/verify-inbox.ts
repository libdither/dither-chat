/**
 * The one ranked inbox (docs/inbox.md), end to end against a demo hub in headless Chromium: the hub's order and
 * its "caught up" line, reasons on hover and in the row's menu, no reshuffle while the pointer is on the list and
 * a new order once it leaves, the filter chips, and old Groups links.
 *
 *   bun scripts/verify-inbox.ts http://127.0.0.1:8472 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this sends a message.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8472';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
if (!boot.attention) throw new Error('this hub does not rank the inbox');
const shapeOf = new Map<string, string>(boot.conversations.map((c: any) => [c.id, c.shape]));

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const mouse = (type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none') =>
  p.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x: number, y: number, button: 'left' | 'right' = 'left') => {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button);
  await mouse('mouseReleased', x, y, button);
};
const center = async (sel: string, pick = 'el => true'): Promise<[number, number]> => {
  const r = await p.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
/** The rows on screen, in order, and where the line is. */
const shown = () =>
  p.eval<{ keys: string[]; divider: number }>(`(() => {
    const kids = [...document.querySelector('.sidebar .side-scroll').children];
    const keys = [], at = { divider: -1 };
    for (const el of kids) {
      if (el.classList.contains('caught-up')) at.divider = keys.length;
      else if (el.dataset.row) keys.push(el.dataset.row);
    }
    return { keys, divider: at.divider < 0 ? keys.length : at.divider };
  })()`);
const away = () => mouse('mouseMoved', 900, 450);
const shot = async (name: string) => shots && p.shot(`${shots}/${name}.png`);

try {
  await p.size(1400, 900);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('.sidebar .conv-row').length > 3`, 15000);
  await away();
  await Bun.sleep(2500);

  // The hub's order and line.
  const scores = new Map<string, any>(((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.map((a: any) => [a.id, a]));
  let s = await shown();
  const above = s.keys.slice(0, s.divider);
  check(!(await p.eval(`!!document.querySelector('.rail [aria-label^="Groups"]')`)), 'the rail has no Groups entry');
  check(s.divider > 0 && s.divider < s.keys.length, 'a "caught up" line divides the list', s.divider);
  check(above.every((k) => scores.get(k)?.needs) && s.keys.slice(s.divider).every((k) => !scores.get(k)?.needs), 'above the line exactly what the hub says needs you');
  check(above.every((k, i) => i === 0 || scores.get(above[i - 1]).score >= scores.get(k).score), 'in the hub’s order');
  check(s.keys.some((k) => shapeOf.get(k) === 'group') && s.keys.some((k) => shapeOf.get(k) === 'direct') && s.keys.some((k) => shapeOf.get(k) === 'self'), 'DMs, groups and notes to self in one list');
  await shot('inbox-01-desktop');

  // Why it is there.
  const top = s.keys[0];
  const title = await p.eval<string>(`document.querySelector('[data-row="${top}"]').title`);
  check(title && title.split('\n')[0] === scores.get(top).reasons[0], 'hovering a row says why', title.split('\n')[0]);
  await click(...(await center(`[data-row="${top}"]`)), 'right');
  await Bun.sleep(400);
  const why = await p.eval<string>(`document.querySelector('.cm-why')?.innerText ?? ''`);
  check(why.includes(scores.get(top).reasons[0]), 'its menu says why, first', why.split('\n').slice(0, 2));
  await shot('inbox-02-row-menu');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await Bun.sleep(300);

  // Answering a group that needs you turns what you owed into a conversation going on: it stays above the line, at
  // its new score, but not while the pointer is on the list. (A group: in a demo DM the other side answers back a few
  // seconds later, which would open a new turn.)
  const groupsAbove = above.filter((k) => shapeOf.get(k) === 'group');
  await mouse('mouseMoved', ...(await center('.sidebar .conv-row', `el => !${JSON.stringify(groupsAbove)}.includes(el.dataset.row)`)));
  const before = await shown();
  // Some demo groups refuse a send (an encrypted room without encryption set up): the first that takes one.
  let target = '';
  for (const k of groupsAbove) {
    const r = await fetch(`${hub}/api/conversations/${k}/send`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ body: 'on it' }) });
    if (r.ok) {
      target = k;
      break;
    }
  }
  check(target, 'answered a group that needs you');
  const was = scores.get(target)?.score;
  const live = (x: any) => x?.reasons?.[0]?.startsWith("You're in a conversation here");
  let now: any = null;
  for (let i = 0; i < 30 && !live(now); i++) {
    await Bun.sleep(200);
    now = ((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.find((x: any) => x.id === target);
  }
  check(live(now) && now.needs, 'the hub now counts it as a conversation going on, still above the line', { was, now: now?.score, reasons: now?.reasons });
  await Bun.sleep(2500);
  s = await shown();
  check(s.keys.join() === before.keys.join() && s.divider === before.divider, 'nothing moves while the pointer is on the list');
  await away();
  await Bun.sleep(3000);
  s = await shown();
  const at = s.keys.indexOf(target);
  const fresh = new Map(((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.map((x: any) => [x.id, x.score]));
  const aboveNow = s.keys.slice(0, s.divider);
  check(at < s.divider && aboveNow.every((k, i) => i === 0 || (fresh.get(aboveNow[i - 1]) as number) >= (fresh.get(k) as number)), 'once it leaves, the list takes the new order', { from: before.keys.indexOf(target), to: at, divider: s.divider });
  await shot('inbox-03-after-answer');
  const lastAt = new Map(((await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any).conversations.map((c: any) => [c.id, c.lastMessageAt ?? 0]));
  // Muted places sit at −50 and go last.
  const below = s.keys.slice(s.divider).filter((k) => (fresh.get(k) as number) > -30);
  check(below.length > 1 && below.every((k, i) => i === 0 || (lastAt.get(below[i - 1]) as number) >= (lastAt.get(k) as number)), 'below the line, the latest message first', below.slice(0, 4).map((k) => lastAt.get(k)));

  // Filters.
  const chip = async (label: string) => {
    await click(...(await center('.inbox-chips .chip-btn', `el => el.textContent.trim() === '${label}'`)));
    await away();
    await Bun.sleep(400);
    return shown();
  };
  const all = s.keys.length;
  const people = await chip('People');
  check(people.keys.length > 0 && people.keys.every((k) => shapeOf.get(k) === 'direct'), 'People: only DMs', people.keys.length);
  await shot('inbox-04-people');
  const groups = await chip('Groups');
  check(groups.keys.length > 0 && groups.keys.every((k) => shapeOf.get(k) !== 'direct') && people.keys.length + groups.keys.length === all, 'Groups: everything else');
  const unread = await chip('Unread');
  const bold = await p.eval<number>(`document.querySelectorAll('.sidebar .conv-row.unread').length`);
  check(unread.keys.length > 0 && unread.keys.length === bold, 'Unread: only unread rows', { rows: unread.keys.length, bold });
  await shot('inbox-05-unread');
  await chip('All');

  // An old Groups link.
  const group = boot.conversations.find((c: any) => c.shape === 'group');
  await p.goto(`${hub}/#/groups/c/${group.id}`);
  await Bun.sleep(1200);
  check((await p.eval('location.hash')) === `#/inbox/c/${group.id}` && (await p.eval(`!!document.querySelector('.conv-head')`)), 'an old #/groups link opens the conversation in the inbox', await p.eval('location.hash'));
  await p.goto(`${hub}/#/groups`);
  await Bun.sleep(600);
  check((await p.eval('location.hash')) === '#/inbox', 'and #/groups opens the inbox');

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
