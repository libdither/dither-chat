/**
 * The one ranked inbox (docs/inbox.md), end to end against a demo hub in headless Chromium: one list in the hub's
 * order with muted places last, reasons on hover and in the row's menu, the chat you were just in near the top once
 * you leave it, no reshuffle while the pointer is on the list and a new order once it leaves, the filter chips, the
 * switcher (Ctrl+K) ranked the same way, and old Groups links. Mixed rows (docs/mail.md, slice 8): the demo's mail
 * from people ranks among the chats, a mail row says why, opens the reader beside the inbox, and leaves when archived;
 * newsletters and senders nobody knows stay out.
 *
 *   bun scripts/verify-inbox.ts http://127.0.0.1:8472 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo) with its own data dir: this sends a message.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { inboxLift } from '../packages/web/src/ordering.ts';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8472';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
if (!boot.attention) throw new Error('this hub does not rank the inbox');
const shapeOf = new Map<string, string>(boot.conversations.map((c: any) => [c.id, c.shape]));
// Mail threads in the inbox (slice 8): you and one other is the chips' "direct".
const mailThreads = new Map<string, any>((boot.mail?.threads ?? []).map((t: any) => [t.id, t]));
for (const t of mailThreads.values()) shapeOf.set(t.id, t.participants <= 2 ? 'direct' : 'group');
const isMail = (k: string) => k.startsWith('mth_');
const peerOf = new Map<string, string>(boot.conversations.filter((c: any) => c.shape === 'direct' && c.peerPersonId).map((c: any) => [c.id, c.peerPersonId]));
// Switcher.tsx needs a browser; its name match is small enough to read from source (as packages/web/test/switcher.test.ts).
const src = await Bun.file(resolve(import.meta.dir, '../packages/web/src/ui/Switcher.tsx')).text();
const fuzzyScore: (name: string, q: string) => number | null = new Function(
  `${src.slice(src.indexOf('export function fuzzyScore'), src.indexOf('interface Item')).replace('export function', 'function').replace(/: string|: number \| null/g, '')}; return fuzzyScore;`,
)();

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
/** The rows on screen, in order, and whether anything still draws a line between them. */
const shown = () =>
  p.eval<{ keys: string[]; lines: number }>(`(() => {
    const keys = [...document.querySelectorAll('.sidebar .side-scroll [data-row]')].map((el) => el.dataset.row);
    return { keys, lines: document.querySelectorAll('.sidebar .caught-up').length + (/Caught up|Nothing needs you/i.test(document.querySelector('.sidebar .side-scroll').innerText) ? 1 : 0) };
  })()`);
const attention = async () => new Map<string, any>(((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.map((a: any) => [a.id, a]));
/** In the hub's order: by score, muted places (about -50) last; a point of slack for scores that moved since. The first pair out of order, or -1. */
const outOfOrder = (keys: string[], scores: Map<string, any>) =>
  keys.findIndex((k, i) => {
    if (i === 0) return false;
    const a = scores.get(keys[i - 1])?.score ?? 0;
    const b = scores.get(k)?.score ?? 0;
    return !((a < -30) === (b < -30) ? a >= b - 1 : a > b);
  });
const inOrder = (keys: string[], scores: Map<string, any>) => outOfOrder(keys, scores) < 0;
const disorder = (keys: string[], scores: Map<string, any>) => {
  const i = outOfOrder(keys, scores);
  return i < 0 ? null : { at: i, scores: keys.slice(Math.max(0, i - 1), i + 1).map((k) => [scores.get(k)?.score ?? null, shapeOf.get(k)]) };
};
const away = () => mouse('mouseMoved', 900, 450);

/** Mail from people among the chats (slice 8). Last but one: it archives a thread. */
async function mixed() {
  await p.eval(`location.hash = '#/inbox'`);
  await away();
  await Bun.sleep(1500);
  const scores = await attention();
  const s = await shown();
  const mail = s.keys.filter(isMail);
  const subjectOf = (k: string) => mailThreads.get(k)?.subject ?? '';
  check(mail.length >= 2 && s.keys.some((k) => !isMail(k)), 'mixed rows: mail threads among the chats', mail.map(subjectOf));
  check(inOrder(s.keys, scores), 'mixed rows in the hub’s order', disorder(s.keys, scores) ?? '');
  check(mail.every((k) => scores.get(k)?.kind === 'mail'), 'each mail row is the hub’s mail attention');
  // Only mail from people: the newsletters, the notification and the sender nobody knows stay in Mail.
  const subjects = mail.map(subjectOf);
  check(!subjects.some((x) => /Week in Rust|libdither|New arrivals|shipped|Climbing/i.test(x)), 'no newsletters, notifications or unknown senders', subjects);
  const sam = mail.find((k) => /Dinner/.test(subjectOf(k)));
  check(sam, 'Sam’s dinner thread is listed');
  if (!sam) return;
  const row = await p.eval<{ title: string; badge: boolean; subject: string; unread: boolean }>(
    `(() => { const el = document.querySelector('[data-row="${sam}"]'); return { title: el.title, badge: !!el.querySelector('.avatar-net'), subject: el.querySelector('.row-subject')?.textContent ?? '', unread: el.classList.contains('unread') }; })()`,
  );
  check(row.title.split('\n')[0] === scores.get(sam).reasons[0], 'a mail row says why on hover', row.title.split('\n')[0]);
  check(row.badge && /Dinner/.test(row.subject) && row.unread, 'the envelope where the network goes, the subject, bold while unread', row);
  await click(...(await center(`[data-row="${sam}"]`)), 'right');
  await Bun.sleep(400);
  const menu = await p.eval<string>(`document.querySelector('.cm[role="menu"]')?.innerText ?? ''`);
  check(menu.includes(scores.get(sam).reasons[0]) && /Open in Mail/.test(menu) && /Not a person/.test(menu), 'its menu: why, Open in Mail, Not a person', menu.split('\n'));
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await Bun.sleep(300);
  await shot('inbox-08-mixed');
  // Tapping it opens the reader beside the inbox; reading it marks it read, and you were here.
  await click(...(await center(`[data-row="${sam}"]`)));
  await p.until(`!!document.querySelector('.mail-reader .mail-subject')`, 8000);
  check((await p.eval('location.hash')) === `#/inbox/c/${sam}` && (await p.eval(`!!document.querySelector('.sidebar [data-row="${sam}"]')`)), 'it opens the reader, with the inbox beside it', await p.eval('location.hash'));
  let v: any = null;
  const readThere = (x: any) => x?.reasons.some((r: string) => r.startsWith('You were here')) && !x.reasons.some((r: string) => /unread/.test(r));
  for (let i = 0; i < 40 && !readThere(v); i++) {
    await Bun.sleep(250);
    v = (await attention()).get(sam);
  }
  check(readThere(v), 'read, and the hub hears you were there', v?.reasons);
  await Bun.sleep(800);
  check(!(await p.eval(`document.querySelector('[data-row="${sam}"]').classList.contains('unread')`)), 'the row is no longer bold');
  await shot('inbox-09-reader');
  // Archive removes it.
  const r = await fetch(`${hub}/api/mail/move`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ threadIds: [sam], to: 'archive' }) });
  check(r.ok, 'archived it');
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    await Bun.sleep(200);
    gone = !(await attention()).has(sam);
  }
  check(gone, 'archived, the hub lists it no more');
  await p.eval(`location.hash = '#/inbox'`);
  await away();
  await Bun.sleep(1500);
  check(!(await shown()).keys.includes(sam), 'and its row has left the inbox');
}
const shot = async (name: string) => shots && p.shot(`${shots}/${name}.png`);

try {
  await p.size(1400, 900);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('.sidebar .conv-row').length > 3`, 15000);
  await away();
  await Bun.sleep(2500);

  // The learned order is on, and on a fresh demo hub (no activity log yet) it is its prior: the formula's order.
  const model = (await fetch(`${hub}/api/attention/model`).then((r) => r.json())) as any;
  check(model.mode === 'model' && model.moments === 0, 'the learned order is on, at its prior', { mode: model.mode, moments: model.moments });

  // One list, in the hub's order.
  let scores = await attention();
  let s = await shown();
  check(!(await p.eval(`!!document.querySelector('.rail [aria-label^="Groups"]')`)), 'the rail has no Groups entry');
  check(s.lines === 0 && s.keys.length > 3, 'one list, no "caught up" line', { rows: s.keys.length, lines: s.lines });
  check(inOrder(s.keys, scores), 'in the hub’s order, muted places last', disorder(s.keys, scores) ?? '');
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

  // The chat you were just in: a quiet group far down the list. Open it, stay, leave: it moves up. (In the demo world
  // most rows owe a reply, so it climbs a few places; on a real hub it is usually among the first rows.)
  const low = [...s.keys].reverse().find((k) => !isMail(k) && shapeOf.get(k) === 'group' && (scores.get(k)?.score ?? 0) > -30 && !scores.get(k)?.reasons.some((r: string) => r.startsWith('You were here')));
  check(low, 'a quiet group far down the list');
  const lowFrom = s.keys.indexOf(low!);
  await click(...(await center(`[data-row="${low}"]`)));
  await away();
  let here: any = null;
  for (let i = 0; i < 40 && !here?.reasons.some((r: string) => r.startsWith('You were here')); i++) {
    await Bun.sleep(250);
    here = (await attention()).get(low!);
  }
  check(here?.reasons.some((r: string) => r.startsWith('You were here')), 'the hub hears you are there within seconds', { was: scores.get(low!)?.score, now: here?.score, reasons: here?.reasons });
  await Bun.sleep(1500);
  check((await shown()).keys.indexOf(low!) === lowFrom, 'while it is open it keeps its place', { from: lowFrom });
  await p.eval(`location.hash = '#/inbox'`);
  await away();
  await Bun.sleep(3000);
  s = await shown();
  scores = await attention();
  const lowTo = s.keys.indexOf(low!);
  check(lowTo < lowFrom && inOrder(s.keys, scores), 'once you leave, it moves up to where its new score puts it', { from: lowFrom, to: lowTo, of: s.keys.length, disorder: disorder(s.keys, scores) });
  await shot('inbox-03-just-left');

  // Answering a group that needs you makes it a conversation going on, at its new score, but not while the pointer
  // is on the list. (A group: in a demo DM the other side answers back a few seconds later, which would open a new turn.)
  const groupsNeeding = s.keys.filter((k) => !isMail(k) && shapeOf.get(k) === 'group' && scores.get(k)?.needs && k !== low);
  await mouse('mouseMoved', ...(await center('.sidebar .conv-row', `el => !${JSON.stringify(groupsNeeding)}.includes(el.dataset.row)`)));
  const before = await shown();
  // Some demo groups refuse a send (an encrypted room without encryption set up): the first that takes one.
  let target = '';
  for (const k of groupsNeeding) {
    const r = await fetch(`${hub}/api/conversations/${k}/send`, { method: 'POST', headers: { 'content-type': 'application/json', origin: hub }, body: JSON.stringify({ body: 'on it' }) });
    if (r.ok) {
      target = k;
      break;
    }
  }
  check(target, 'answered a group that needs you');
  const was = scores.get(target)?.score;
  const live = (x: any) => x?.reasons?.some((r: string) => r.startsWith("You're in a conversation here"));
  let now: any = null;
  for (let i = 0; i < 30 && !live(now); i++) {
    await Bun.sleep(200);
    now = (await attention()).get(target);
  }
  check(live(now), 'the hub now counts it as a conversation going on', { was, now: now?.score, reasons: now?.reasons });
  await Bun.sleep(2500);
  s = await shown();
  check(s.keys.join() === before.keys.join(), 'nothing moves while the pointer is on the list');
  await away();
  await Bun.sleep(3000);
  s = await shown();
  scores = await attention();
  check(inOrder(s.keys, scores), 'once it leaves, the list takes the new order', { from: before.keys.indexOf(target), to: s.keys.indexOf(target), disorder: disorder(s.keys, scores) });
  await shot('inbox-04-after-answer');

  // Filters.
  const chip = async (label: string) => {
    await click(...(await center('.inbox-chips .chip-btn', `el => el.textContent.trim() === '${label}'`)));
    await away();
    await Bun.sleep(400);
    return shown();
  };
  const all = s.keys.length;
  const people = await chip('People');
  check(people.keys.length > 0 && people.keys.every((k) => shapeOf.get(k) === 'direct'), 'People: only DMs and mail between you and one other', people.keys.length);
  check(people.keys.some(isMail), 'People has mail in it', people.keys.filter(isMail));
  await shot('inbox-05-people');
  const groups = await chip('Groups');
  check(groups.keys.length > 0 && groups.keys.every((k) => shapeOf.get(k) !== 'direct') && people.keys.length + groups.keys.length === all, 'Groups: everything else');
  const unread = await chip('Unread');
  const bold = await p.eval<number>(`document.querySelectorAll('.sidebar .conv-row.unread').length`);
  check(unread.keys.length > 0 && unread.keys.length === bold, 'Unread: only unread rows', { rows: unread.keys.length, bold });
  await shot('inbox-06-unread');
  await chip('All');

  // The switcher: with nothing typed, the top of the inbox (a DM as its person); typed, the match times the score.
  const ctrlK = () => p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await ctrlK();
  await p.until(`!!document.querySelector('.switcher-row')`, 3000);
  const opening = await p.eval<string[]>(`[...document.querySelectorAll('.switcher-row')].map((el) => el.dataset.key)`);
  // Mail threads are not places the switcher lists.
  const inboxTop = [...new Set((await shown()).keys.filter((k) => !isMail(k)).map((k) => peerOf.get(k) ?? k))].slice(0, opening.length);
  check(opening.length > 3 && opening.join() === inboxTop.join(), 'Ctrl+K opens on the top of the inbox', { opening, inboxTop });
  await shot('inbox-07-switcher');
  scores = await attention();
  const scoreOf = (key: string) => {
    const dms = [...peerOf].filter(([, person]) => person === key).map(([c]) => scores.get(c)?.score).filter((x) => x !== undefined);
    return dms.length ? Math.max(...dms) : (scores.get(key)?.score ?? null);
  };
  let ranked = false;
  for (const q of ['a', 'e', 'o']) {
    await p.send('Input.insertText', { text: q });
    await Bun.sleep(300);
    const rows = await p.eval<{ key: string; label: string }[]>(`[...document.querySelectorAll('.switcher-row')].filter((el) => el.dataset.key !== 'search').map((el) => ({ key: el.dataset.key, label: el.querySelector('.switcher-label').textContent }))`);
    const w = rows.map((r) => Math.max(1, fuzzyScore(r.label, q) ?? 0) * inboxLift(scoreOf(r.key)));
    const sorted = w.every((x, i) => i === 0 || w[i - 1] >= x - 1e-9);
    check(sorted, `typing "${q}": best match times score first`, rows.slice(0, 4).map((r, i) => Math.round(w[i])));
    ranked ||= rows.some((r) => scoreOf(r.key) !== null);
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await Bun.sleep(200);
  }
  check(ranked, 'and the scores took part');
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await Bun.sleep(300);

  await mixed();

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
