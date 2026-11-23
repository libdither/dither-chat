/**
 * Mail (docs/mail.md, "Mail as chats") in headless Chromium against a demo hub, whose fake mail account (hub demo.ts
 * seedDemoMail) has a reply thread with quoted text, a Cc'd thread, list mail, and an HTML-only message with a tracker
 * and scripts. There is no Mail page: a person's mail is in their chat, a thread with more people is a chat of its own,
 * and mail's other lists open in the Inbox's place under its Mail filter. On a phone (390x844, touch) and a desktop, in
 * the dark and the light theme:
 *
 *   - no errors on the page, and nothing runs sideways off the screen;
 *   - the Inbox with its Mail filter: people's chats and threads with more people, no newsletters, and the mail lists'
 *     chips (Inbox, Updates, Everything, More) in one row, on a phone too;
 *   - on a phone: the Inbox, a person's chat over it, and back (the button and the browser's back);
 *   - a person's chat: their thread's mails as its messages (yours too), the subject as a tag where the thread starts
 *     and as the pill over the box; the quote behind ···, unless the mail answers the one right above; read here after
 *     a second; a thread's own chat named by its subject, cut with an ellipsis on a phone, beside Archive and ⋯ (Star
 *     and Trash are in ⋯ there);
 *   - an HTML-only message shows its text, and none of its script;
 *   - the Accounts screen's mail account;
 *   - from a person (slice 8): with Mail on, the Inbox has no newsletters or notifications, the Updates chip lists them;
 *     Everything has the newsletters too; an old People link still lists; on a desktop, "Not a person" and "This is a
 *     person" from a row's menu.
 *   - filing (slice 4): read in view reaches the server; on a phone a swipe right archives and Undo brings it back,
 *     a swipe left marks unread and read, a long press picks threads and their bar stars them; on a desktop the
 *     thread's header (Archive, Star, ⋯ with the trash), the `e` key, a row's right-click menu, Ctrl-click picking,
 *     and the read setting.
 *   - search (slice 7): a mail list's search box, the hub's hits (marked) and what only the server has, a hit opening
 *     its chat over the results and back to them; the search page's Mail group and its way into the list.
 *   - writing (slice 5), last, since it sends: on a phone, Sam's chat's box with its subject pill: the words go as a
 *     reply on that thread, held with Undo (Undo puts them back in the box), then sent. A mail's menu has "Reply in the
 *     full editor", which fills in To, the subject and the quote; a Cc typed in, a file attached; Send, "Sending…
 *     Undo", Undo brings the draft back, Send again, and the reply joins the chat with its file and its Markdown bold,
 *     drawn in the app's theme under ··· (its plain, formatted HTML part is not put on a white sheet); a chip opens
 *     back into text with Backspace and Ctrl+Z makes it a chip again. On a desktop, New email (the Inbox's +) docks a
 *     new message whose To completes from your mail and from the account's server; a clicked chip opens to edit and
 *     goes back in its place; the editor's bar (B, lists, heading, table), its Markdown and HTML views, a table and
 *     centred text kept through edits there; Plain; Ctrl+Z; a picture pasted into the text; closing keeps a draft
 *     that opens again; the picture bar's choice for one mail; a forward of a big newsletter keeps its layout, Link
 *     says how many of its pictures can tell, and it sends its pictures inside the mail when asked from the Drafts
 *     line; discarding offers Undo, then the draft is gone.
 *
 * With --html (slice 3, htmlChecks below), the HTML frame (a mail's ··· then "Show as sent") in Chromium: no script
 * runs in it, even put there by hand; no request leaves for anywhere but the hub; a link click goes through the app's
 * opener and never moves the frame, and one whose text names another site asks first; the remote-image banner and the
 * proxy; quotes folded; cid: pictures; files open in the viewers; swiping back over a body works on a phone; a white
 * sheet in both themes.
 *
 * With --big (a hub started with DITHER_DEMO_MAIL_BIG=1: years of Archive, and a folder the hub does not follow),
 * first: the progress line while the backfill runs, and gone after it; a mailbox's list goes on as it is scrolled; the
 * folder lists its first page when opened and the server's older pages as it is scrolled past what the hub holds,
 * back past the year the hub keeps; nothing off the side.
 *
 * With --proton (a hub started with DITHER_DEMO_MAIL_PROTON=1: a second account whose summaries carry no headers, as
 * Proton's), only that account's run: its newsletter, which says it is one only in its body, reaches Updates once
 * its body was fetched ahead and is never in Inbox; the receipt Proton sorted into Transactions is in Updates; the
 * stranger's note stays in Inbox; on a phone and a desktop, both themes, nothing off the side. With two accounts, the
 * wheels over a mail list pick the account: the account menu has each with the colour of its rows' dot, and says what
 * the dot is.
 *
 * With --gmail (a hub started with DITHER_DEMO_MAIL_GMAIL=1: a Gmail account as dither-accounts' imap extractor gives
 * one), only that account's run, on a phone and a desktop in both themes: it is in the account menu; its labels are in
 * More's menu and `[Gmail]`, which only holds mailboxes, is not; a label lists its threads; one row a thread in Inbox,
 * All Mail and a label; Archive, then Undo before it reaches Gmail, then Archive for good (out of Inbox, still in All
 * Mail and its label), then the thread header's Move to Inbox (a copy from All Mail: back in Inbox once, still in All
 * Mail and its label, one message); Move to the trash (out of every mailbox but Trash); nothing off the side.
 *
 *   bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir] [--html] [--big] [--proton] [--gmail]
 * The hub must be a fresh demo hub (--demo) with its own data dir: reading marks threads read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const withHtml = args.includes('--html');
const bigRun = args.includes('--big');
const protonRun = args.includes('--proton');
const gmailRun = args.includes('--gmail');
const [base, shots] = args.filter((a) => !a.startsWith('--'));
if (!base) throw new Error('usage: bun scripts/verify-mail.ts <hub url> [screenshot dir] [--html] [--big] [--proton] [--gmail]');
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
if (boot.mail?.access?.state !== 'granted') throw new Error('this demo hub has no mail');
// A hub just started may still be on its first page (a slow server: --big).
const page1 = async (list: string) => ((await fetch(`${base}/api/mail/threads?list=${encodeURIComponent(list)}&limit=100`).then((r) => r.json())) as any).threads as any[];
// Inbox leaves mail not from a person to its Updates row (slice 8).
let inboxThreads: any[] = [];
for (let i = 0; i < 60 && !inboxThreads.some((t) => t.subject.includes('Lease renewal')); i++) {
  if (i) await Bun.sleep(500);
  inboxThreads = await page1('v:inbox:*');
}
const updateThreads = await page1('v:updates:*');
const threads = [...inboxThreads, ...updateThreads];
const byTitle = (s: string) => threads.find((t) => t.subject.includes(s))!;
const dinner = byTitle('Dinner on Friday');
const shipped = byTitle('Your order has shipped');
const lease = byTitle('Lease renewal');
const github = byTitle('libdither/dither-chat');
const garden = byTitle('The garden plan');
if (!dinner || !shipped || !lease || !github || !garden) throw new Error('the demo mail is not as seeded');
/** Mail as chats: a person's chat holds their mail, by an email route (docs/mail.md "Mail as chats"). */
const mailChats = (((await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as any).mail?.chats ?? []) as any[];
const routeOf = (address: string) => mailChats.find((c) => c.address.startsWith(address));
const samRoute = routeOf('sam@');
const aliceRoute = routeOf('alice');
if (!samRoute || !aliceRoute) throw new Error('the demo mail has no chats for Sam and Alice');
/** A thread's mails, oldest first, as the hub has them. */
const mailsOf = async (id: string) => ((await fetch(`${base}/api/mail/threads/${id}`).then((r) => r.json())) as any).messages as any[];
/** Sam's last mail in the dinner thread, as seeded. */
const booked = (await mailsOf(dinner.id)).at(-1);
/** A mail list in the Inbox's place, and a chat opened from it. */
const inList = (key: string, conv?: string) => `#/inbox${conv ? `/c/${encodeURIComponent(conv)}` : ''}?mail=${encodeURIComponent(key)}`;
/** A message in a chat (its id), and the chat's pane. */
const msg = (id: string) => `[id="m-${id}"]`;
const PANE = '.center .pane';

const { page, close } = await launch();
let failed = 0;
const check = (name: string, ok: unknown, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const shot = async (name: string) => shots && page.shot(`${shots}/${name}.png`);

// ------------------------------------------------------------------ input

type Pt = [number, number];
const touch = (type: string, pts: Pt[]) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function tap([x, y]: Pt) {
  await touch('touchStart', [[x, y]]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
  await Bun.sleep(400);
}
async function click([x, y]: Pt) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await Bun.sleep(350);
}
/** A right-click, or a long press on a phone: the element's own menu. */
async function openMenuOn(sel: string) {
  await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.x + 4, clientY: b.y + b.height / 2 })); })()`);
  await Bun.sleep(350);
}
/** A long press, as a phone opens a message's menu. */
async function hold(p: Pt) {
  await touch('touchStart', [p]);
  await Bun.sleep(650);
  await touch('touchEnd', []);
  await Bun.sleep(300);
}
async function at(sel: string, pick = 'el => true'): Promise<Pt> {
  const find = `[...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick})`;
  const r = await page.eval<Pt | null>(`(() => {
    const el = ${find};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  // Still where it was measured: a list can re-sort under it as the demo world's people write in (the inbox ranks).
  // Measured again until two looks 150 ms apart agree, so the check below and the press hit what was asked for.
  const place = `(() => { const el = ${find}; if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; })()`;
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(150);
    const now = await page.eval<Pt | null>(place);
    if (!now) throw new Error(`${sel} went away`);
    if (now[0] === r[0] && now[1] === r[1]) break;
    await page.eval(`${find}?.scrollIntoView({ block: 'center' })`);
    [r[0], r[1]] = (await page.eval<Pt | null>(place)) ?? r;
  }
  // The demo world's people write in on their own, and a toast for it can sit over the target: a tap would close the
  // toast instead. Dismiss the ones in the way first.
  const covered = `(() => { const top = document.elementFromPoint(${r[0]}, ${r[1]}); return !!top?.closest('.toasts') && !${find}?.contains(top); })()`;
  if (await page.eval<boolean>(covered)) {
    await page.eval(`document.querySelectorAll('.toasts .toast-x').forEach((x) => x.click())`);
    await page.until(`!${covered}`, 5000);
  }
  // Anything else there (it moved, or something sits over it): say so here, not as a press that did nothing.
  const top = await page.eval<string | null>(`(() => { const top = document.elementFromPoint(${r[0]}, ${r[1]}); return ${find}?.contains(top) ? null : (top ? top.tagName + '.' + (top.className?.baseVal ?? top.className) : 'nothing'); })()`);
  if (top) throw new Error(`${sel} is not at ${r} (${top} is)`);
  return r;
}
const has = (sel: string) => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const hash = () => page.eval<string>('location.hash');
/** On screen and not moved off it (the phone's card slides). */
const inView = (sel: string) =>
  page.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.left < innerWidth - 20; })()`);

// ------------------------------------------------------------------ layout (as verify-phone.ts)

// Rows meant to scroll sideways: on a phone the editor's bar is one (its view switch stays at its end).
const SIDEWAYS = '.level-picker, .ident-chips, .composer-files, .sheet-quick, pre, code, .log-view, .detail-dump, .lv-screen, .mail-chips, .me-bar';
async function overflow(): Promise<string[]> {
  return page.eval(`(() => {
    const W = innerWidth, out = [], sideways = ${JSON.stringify(SIDEWAYS)};
    if (document.scrollingElement.scrollWidth > W + 1) out.push('document ' + document.scrollingElement.scrollWidth);
    const moved = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).transform !== 'none') return true; return false; };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.left >= W || r.right <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const name = (el.className && typeof el.className === 'string' ? el.className : el.tagName).trim();
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.matches(sideways) && !moved(el)) out.push(name + ' scrolls sideways by ' + (el.scrollWidth - el.clientWidth));
      if (r.right <= W + 1 || cs.position === 'fixed') continue;
      let fine = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.transform !== 'none' || (p !== el && p.matches(sideways))) { fine = true; break; }
        if (ps.textOverflow === 'ellipsis' || ps.maskImage !== 'none' || ps.webkitMaskImage !== 'none') { fine = true; break; }
      }
      if (!fine) out.push(name + ' right=' + Math.round(r.right));
    }
    return [...new Set(out)].slice(0, 8);
  })()`);
}
async function overflowThrough(scroller: string): Promise<string[]> {
  const n = await page.eval<number>(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); return el ? Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight * 0.8)) : -1; })()`);
  if (n < 0) return [`no ${scroller}`];
  const found = new Set<string>();
  for (let i = 0; i <= n; i++) {
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); el.scrollTop = ${i} * el.clientHeight * 0.8; })()`);
    await Bun.sleep(60);
    for (const o of await overflow()) found.add(o);
  }
  await page.eval(`document.querySelector(${JSON.stringify(scroller)}).scrollTop = 0`);
  return [...found];
}

/** The theme, then a fresh load of `hash` with it. The Inbox shows mail only (its Mail filter), as mail's lists are its. */
async function theme(name: string, hash: string) {
  await page.goto(`${base}/#/inbox`);
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)}, inboxFilter: 'mail' }))`);
  await page.eval(`(location.hash = ${JSON.stringify(hash)}, location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await page.until(`!!document.querySelector('.app')`, 15000);
  // The theme took: a light one draws on a light background.
  const light = await page.eval<boolean>(`(() => { const m = getComputedStyle(document.querySelector('.sidebar')).backgroundColor.match(/\\d+(\\.\\d+)?/g).map(Number); return (m[0] * 0.3 + m[1] * 0.59 + m[2] * 0.11) > 140; })()`);
  check(`${name} is on`, light === name.includes('light'));
}

/** The mail lists' chips under the Inbox's search: how many rows they take, and their names. */
const chipRows = () =>
  page.eval<{ rows: number; chips: string }>(`(() => {
    const cs = [...document.querySelectorAll('.sidebar .mail-list-chips .chip-btn')];
    return { rows: new Set(cs.map((c) => Math.round(c.getBoundingClientRect().top))).size, chips: cs.map((c) => c.textContent.trim()).join(',') };
  })()`);
/** A thread's chat header's name: its lines, and whether all of it shows. */
const subjectBox = () =>
  page.eval<{ text: string; lines: number; whole: boolean; ellipsis: boolean }>(`(() => {
    const el = document.querySelector('.mail-thread-head .mail-subject');
    const cs = getComputedStyle(el);
    return { text: el.textContent, lines: Math.round(el.clientHeight / parseFloat(cs.lineHeight)), whole: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1, ellipsis: cs.textOverflow === 'ellipsis' };
  })()`);
/** The aria-labels of a thread chat's header buttons. */
const headButtons = () => page.eval<string[]>(`[...document.querySelectorAll('.mail-thread-head .conv-head-actions .hdr-btn')].map((b) => b.getAttribute('aria-label'))`);
/** The Inbox's rows (with the Mail filter: people's chats and threads with more people), by key. */
const inboxRows = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .row[data-row]')].map((r) => r.dataset.row)`);

// ------------------------------------------------------------------ the runs

async function phone(themeName: string, first: boolean) {
  const tag = `phone ${themeName}`;
  await page.size(390, 844, true);
  await theme(themeName, '#/inbox');
  await page.until(`!!document.querySelector('.app.phone')`, 15000);
  // The rail's Mail entry is gone: mail is in the Inbox, under its Mail filter (docs/mail.md "Mail as chats").
  await page.until(`!!document.querySelector('.sidebar .mail-list-chips') && document.querySelectorAll('.sidebar .row[data-row]').length >= 3`, 15000);
  await Bun.sleep(600);
  // The Mail filter's Inbox: Sam's chat (his mail is in it) and the lease thread (more people, a chat of its own), and
  // none of the newsletters, which Updates holds. Ranking them is the Inbox's (verify-inbox.ts), not mail's.
  const bulk = new Set(updateThreads.map((t) => t.id));
  const rows = await inboxRows();
  check(`${tag}: the Inbox with Mail on: Sam's chat and the lease thread, no newsletters`, rows.includes(`person:${samRoute.personId}`) && rows.includes(lease.id) && !rows.some((id) => bulk.has(id)), rows);
  check(`${tag}: no sideways overflow: the Inbox`, !(await overflow()).length, await overflow());
  const bar = await chipRows();
  check(`${tag}: the mail lists are one row of chips: Inbox, Updates, Everything, More`, bar.rows === 1 && bar.chips === 'Inbox,Updates,Everything,More', bar);
  await shot(`mail-${tag.replace(' ', '-')}-inbox`);

  // The Inbox, then Sam's chat over it, then back.
  const mails = await mailsOf(dinner.id);
  await tap(await at(`.sidebar .row[data-row="person:${samRoute.personId}"]`));
  await page.until(`!!document.querySelector(${JSON.stringify(msg(mails.at(-1).id))})`, 15000);
  check(`${tag}: Sam's chat opens as a card over the Inbox`, (await hash()).includes(`/c/`) && (await inView(PANE)), await hash());
  const shown = await page.eval<string[]>(`${JSON.stringify(mails.map((m) => m.id))}.filter((id) => document.getElementById('m-' + id))`);
  // The reader folded read mails to a line; a chat shows every one as a message (dropped: the folded snippets).
  check(`${tag}: the thread's mails are messages in Sam's chat, yours too`, shown.length === mails.length && (await page.eval<string>(`document.getElementById('m-${mails.find((m) => m.addressed === 'self')?.id}')?.textContent ?? ''`)).includes('Yes, 7:30 works'), { shown: shown.length, mails: mails.length });
  const tags = await page.eval<string[]>(`[...document.querySelectorAll('${PANE} .mail-tag')].map((t) => t.textContent.trim())`);
  check(`${tag}: the subject is a tag where the thread starts, without its Re:`, tags.join() === 'Dinner on Friday?', tags);
  const pill = await page.eval<string>(`document.querySelector('.typing-lead .mail-pill')?.textContent ?? ''`);
  check(`${tag}: the pill over the box says the thread an answer goes into`, pill.includes('Dinner on') && pill.includes('Friday?'), pill);
  // The latest answers the mail right above it, so its quote is no reason for ···: what ··· holds is not the quote.
  const last = msg(mails.at(-1).id);
  if (await has(`${last} .mail-quote-dots`)) {
    await tap(await at(`${last} .mail-quote-dots`));
    await Bun.sleep(300);
  }
  check(`${tag}: a mail answering the one right above keeps its quote out of ···`, !(await has(`${last} .chat-mail-quote`)) && !(await page.eval<boolean>(`(document.querySelector('${last}')?.textContent ?? '').includes('Should I book a table')`)));
  if (first) {
    // The tag's card: the thread in a line, its Archive and Star.
    await tap(await at(`${PANE} .mail-tag`));
    await page.until(`!!document.querySelector('.cm-sheet, .cm')`, 5000);
    const card = await page.eval<string>(`(document.querySelector('.cm-sheet') ?? document.querySelector('.cm')).textContent`);
    check(`${tag}: the subject tag opens the thread's card, with Archive and Star`, card.includes('3 mails · with Sam Rivera') && card.includes('Archive') && card.includes('Star'), card);
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await page.until(`!document.querySelector('.cm-sheet, .cm')`, 5000).catch(() => {});
    // Read here after a second in view.
    await Bun.sleep(1600);
    const t = (await page1('v:inbox:*')).find((x: any) => x.id === dinner.id);
    check(`${tag}: read here after a second in view`, t?.unread === 0, t?.unread);
  }
  check(`${tag}: no sideways overflow: a person's chat`, !(await overflowThrough(`${PANE} .timeline-scroll`)).length, await overflowThrough(`${PANE} .timeline-scroll`));
  await shot(`mail-${tag.replace(' ', '-')}-chat`);
  await tap(await at(`${PANE} .conv-head .icon-btn.back`));
  await Bun.sleep(400);
  check(`${tag}: back goes to the Inbox`, !(await hash()).includes('/c/') && (await inView('.sidebar .side-scroll')), await hash());

  if (first) {
    // A quote that answers no mail in the chat: behind ···, which shows it (Alice's garden plan answers a mail of yours
    // that is not in her chat).
    const [plan] = (await mailsOf(garden.id)).filter((m) => m.addressed !== 'self');
    await page.eval(`location.hash = ${JSON.stringify(`#/inbox/c/${encodeURIComponent(aliceRoute.id)}?m=${plan.id}`)}`);
    await page.until(`!!document.querySelector(${JSON.stringify(`${msg(plan.id)} .mail-quote-dots`)})`, 15000);
    check(`${tag}: the quote is folded behind ···`, !(await has(`${msg(plan.id)} .chat-mail-quote`)));
    await tap(await at(`${msg(plan.id)} .mail-quote-dots`));
    await page.until(`(document.querySelector(${JSON.stringify(`${msg(plan.id)} .chat-mail-quote`)})?.textContent ?? '').includes('Could you send the plan')`, 10000).catch(() => {});
    check(`${tag}: ··· shows the quote`, await page.eval(`(document.querySelector(${JSON.stringify(`${msg(plan.id)} .chat-mail-quote`)})?.textContent ?? '').includes('Could you send the plan')`));
    await page.eval('history.back()');
    await page.until(`!location.hash.includes('/c/')`, 5000).catch(() => {});
  }

  // The HTML-only message, from Everything: its text part in the chat; none of its script.
  await tap(await at('.sidebar .mail-list-chips .chip-btn', `el => el.textContent === 'Everything'`));
  await page.until(`location.hash.includes('v%3Aall')`, 5000);
  await tap(await at(`.sidebar .mail-row[data-thread="${shipped.id}"]`));
  const [order] = await mailsOf(shipped.id);
  const words = `(document.querySelector(${JSON.stringify(`${msg(order.id)} .mail-words`)})?.textContent ?? '')`;
  await page.until(`${words}.length > 10`, 15000);
  const text = await page.eval<string>(words);
  check(`${tag}: an HTML-only message shows`, text.includes('your order #4471 has shipped') && text.includes('Track your parcel'), text.slice(0, 120));
  check(`${tag}: none of its script shows or runs`, !/alert|evil|hacked/.test(text) && !(await page.eval(`document.title.includes('hacked')`)));
  await page.eval('history.back()');
  await Bun.sleep(500);
  check(`${tag}: the browser's back goes to the list too`, !(await hash()).includes('/c/') && (await hash()).includes('v%3Aall'), await hash());
  if (first) {
    // A long subject names the thread's chat: one line, cut with an ellipsis, beside Archive and ⋯.
    await page.eval(`location.hash = '#/inbox/c/${github.id}'`);
    // Named without its Re: (bareSubject), as every subject is drawn.
    await page.until(`document.querySelector('.mail-thread-head .mail-subject')?.textContent === ${JSON.stringify(github.subject.replace(/^Re: /, ''))}`, 10000);
    await Bun.sleep(400);
    const long = await subjectBox();
    check(`${tag}: a long subject is cut with an ellipsis, not run off the side`, long.lines === 1 && !long.whole && long.ellipsis, long);
    check(`${tag}: beside it only Archive and ⋯`, (await headButtons()).join() === 'Archive,More', await headButtons());
    await tap(await at('.mail-thread-head .hdr-btn[aria-label="More"]'));
    await page.until(`!!document.querySelector('.cm-sheet')`, 5000);
    const items = await page.eval<string>(`document.querySelector('.cm-sheet').textContent`);
    check(`${tag}: ⋯ has Star and Move to the trash`, items.includes('Star') && items.includes('Move to the trash'), items);
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await page.until(`!document.querySelector('.cm-sheet')`, 5000).catch(() => {});
    check(`${tag}: no sideways overflow: a thread's chat`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-thread-long-subject`);
    await page.eval(`location.hash = '#/inbox'`);
    await page.until(`!location.hash.includes('/c/')`, 5000);
    await Bun.sleep(500);
  }

  // Sent from More's menu, then the mail account in Accounts' one list (docs/accounts.md).
  await page.eval(`location.hash = ${JSON.stringify(inList('v:updates:*'))}`);
  await page.until(`!!document.querySelector('.sidebar .mail-more-chip')`, 5000);
  await tap(await at('.sidebar .mail-more-chip'));
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  await tap(await menuItem('Sent'));
  await page.until(`location.hash.includes('v%3Asent')`, 5000);
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 3`, 5000).catch(() => {});
  check(`${tag}: Sent lists what you sent`, (await page.eval<number>(`document.querySelectorAll('.sidebar .mail-row').length`)) >= 3);
  check(`${tag}: More is lit with its name`, (await page.eval<string>(`document.querySelector('.sidebar .mail-more-chip.on')?.textContent ?? ''`)).includes('Sent'));
  await page.goto(`${base}/#/accounts`);
  await page.until(`!!document.querySelector('.acc-row [data-feature="mail"]')`, 10000);
  check(`${tag}: Accounts lists the mail account with the others, with a mail icon`, (await page.eval<string>(`document.querySelector('.acc-row:has([data-feature="mail"])').textContent`)).includes('zyan@dither.example'));
  check(`${tag}: no sideways overflow: accounts`, !(await overflow()).length, await overflow());
}

async function desktop(themeName: string) {
  const tag = `desktop ${themeName}`;
  await page.size(1400, 900);
  await theme(themeName, inList('v:all:*'));
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 15000);
  // The Mail page's welcome pane is gone: with no chat open the centre is the app's own (For you, say).
  check(`${tag}: no thread open yet: no chat in the centre`, !(await has(`${PANE} .conv-head`)));
  const bar = await chipRows();
  check(`${tag}: the mail lists are one row of chips: Inbox, Updates, Everything, More`, bar.rows === 1 && bar.chips === 'Inbox,Updates,Everything,More', bar);
  const mails = await mailsOf(lease.id);
  await click(await at(`.sidebar .mail-row[data-thread="${lease.id}"]`));
  await page.until(`!!document.querySelector(${JSON.stringify(`.mail-thread-pane ${msg(mails.at(-1).id)}`)})`, 15000);
  check(`${tag}: the list and the thread's chat side by side`, (await inView('.sidebar .mail-row')) && (await inView('.center .mail-thread-pane')));
  // The reader opened a folded message with its Cc; a thread's chat has every mail open, and names its people, the
  // Cc'd too, under its name.
  check(`${tag}: every mail of the thread is a message`, await page.eval<boolean>(`${JSON.stringify(mails.map((m) => m.id))}.every((id) => document.getElementById('m-' + id))`));
  const people = await page.eval<string>(`document.querySelector('.mail-thread-head .mail-people')?.textContent ?? ''`);
  check(`${tag}: under its name, the people on it, the Cc'd too`, people.includes('Alice Chen') && people.includes('Jo Park'), people);
  check(`${tag}: the thread's filing in its header: Archive, Star, ⋯`, (await headButtons()).join() === 'Archive,Star,More', await headButtons());
  check(`${tag}: the open row is marked`, await has(`.sidebar .mail-row.active[data-thread="${lease.id}"]`));
  check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(' ', '-')}`);
  // The switcher finds the mailboxes.
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await Bun.sleep(200);
  await page.eval(`(() => { const i = document.querySelector('.switcher-input'); i.value = 'Archive'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(200);
  check(`${tag}: Ctrl+K finds a mailbox`, (await page.eval<string>(`document.querySelector('.switcher-list')?.textContent ?? ''`)).includes('Mailbox'));
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
}

// ------------------------------------------------------------------ writing (slice 5)

/** Text typed into a field, as a person would (the input event the page listens for). */
const type = (sel: string, text: string) =>
  page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const key = (sel: string, k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) =>
  page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, ...${JSON.stringify(mods)}, bubbles: true, cancelable: true }))`);
/** The editor's text, as it reads. */
const bodyText = () => page.eval<string>(`(document.querySelector('.me-rich-doc')?.innerText ?? '').trim()`);
/** A key pressed for real (DevTools input) on what has focus; mods: 2 Ctrl, 8 Shift. */
async function press(key: string, code: string, vk: number, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
}
/**
 * Text typed into the editor as a person would: in place of everything there (`all`), at the start, above a reply's
 * quote (`start`), or wherever the editor left its caret (`caret`).
 */
async function typeBody(text: string, where: 'all' | 'start' | 'caret' = 'all') {
  await page.eval(`(() => { const d = document.querySelector('.me-rich-doc'); d.focus(); ${where === 'all' ? "document.execCommand('selectAll');" : where === 'start' ? "getSelection().collapse(d.querySelector('p') ?? d, 0);" : ''} })()`);
  if (where === 'all') await press('Delete', 'Delete', 46);
  await page.send('Input.insertText', { text });
}
/** The text "Here they are." with `word` selected (ProseMirror follows the page's selection). */
const selectWord = (word: string) =>
  page.eval(`(() => { const d = document.querySelector('.me-rich-doc'); d.focus(); const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode()); ) { const i = n.data.indexOf(${JSON.stringify(word)}); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${word.length}); getSelection().removeAllRanges(); getSelection().addRange(r); return true; } } return false; })()`);
const chipped = (email: string) => page.eval<boolean>(`[...document.querySelectorAll('.mc-chip')].some((c) => c.textContent.includes(${JSON.stringify(email)}))`);
const outbox = async () => ((await fetch(`${base}/api/mail/outbox`).then((r) => r.json())) as any).items as any[];
const threadNow = async (id: string) => (await fetch(`${base}/api/mail/threads/${id}`).then((r) => r.json())) as any;
/** A file for the file picker, through the browser's own protocol. */
async function pickFile(sel: string, path: string) {
  const r = await page.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` });
  await page.send('DOM.setFileInputFiles', { files: [path], objectId: r.result.objectId });
}

/** The chat's box, and its send button once there is something to send. */
const BOX = '.composer textarea';
const SEND = '.composer .send-btn[data-track="send"]';
/** Words typed into the chat's box as a person would. */
async function typeInBox(text: string) {
  await page.eval(`document.querySelector(${JSON.stringify(BOX)}).focus()`);
  await page.send('Input.insertText', { text });
  await page.until(`document.querySelector(${JSON.stringify(BOX)}).value === ${JSON.stringify(text)}`, 5000);
}

/**
 * Sam's chat on a phone. The light run answers from the chat's box (the reader's Reply bar is gone: the box under the
 * subject pill is the reply) and opens the full editor from a mail's menu; the dark run sends from the full editor.
 */
async function composer(themeName: string, full: boolean) {
  const tag = `composer phone ${themeName}`;
  await page.size(390, 844, true);
  await theme(themeName, `#/inbox/c/${encodeURIComponent(samRoute.id)}`);
  const mails = await mailsOf(dinner.id);
  // Sam's "Booked for 7:30", as seeded: the mail the full editor answers (Sam answers the box's mail by himself).
  const theirs = mails.find((m) => m.id === booked.id)!;
  await page.until(`!!document.querySelector(${JSON.stringify(msg(theirs.id))})`, 15000);
  if (!full) {
    // The box answers on the thread the pill names; held for Undo under the chat's messages, as a mail sent from Mail.
    const lead = await page.eval<{ pill: string; placeholder: string }>(`({ pill: document.querySelector('.typing-lead .mail-pill')?.textContent ?? '', placeholder: document.querySelector(${JSON.stringify(BOX)}).placeholder })`);
    check(`${tag}: the box's pill names the thread it answers`, lead.pill.includes('Friday?'), lead);
    const words = 'Running ten minutes late.';
    await typeInBox(words);
    await tap(await at(SEND));
    await page.until(`!!document.querySelector('.mail-sends .mail-send.held')`, 10000);
    const held = await page.eval<string>(`document.querySelector('.mail-sends .mail-send.held').textContent`);
    check(`${tag}: the box's mail is held, with Undo and Send now`, held.includes(words) && held.includes('Friday?') && /Sending in \d+ s/.test(held) && held.includes('Undo') && held.includes('Send now'), held);
    check(`${tag}: and the box is empty`, (await page.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`)) === '');
    check(`${tag}: no sideways overflow: held`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(/ /g, '-')}-held-in-chat`);
    // Its Undo and Send now are where a tap reaches them, not under the outbox's strip (Composer.tsx), which says the
    // same send again over the box.
    const covered = await page.eval<string[]>(`[...document.querySelectorAll('.mail-send.held .link-btn')].filter((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !b.contains(top); }).map((b) => b.textContent.trim() + ' under ' + (document.elementFromPoint(b.getBoundingClientRect().x + 4, b.getBoundingClientRect().y + 4)?.closest('[class]')?.className ?? 'nothing'))`);
    check(`${tag}: the chat's held line can be tapped: nothing over its Undo and Send now`, !covered.length, covered);
    // Pressed as a tap would if nothing were over them, so what they do is checked all the same.
    const press = (label: string) => page.eval(`[...document.querySelectorAll('.mail-send.held .link-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
    await press('Undo');
    await page.until(`!document.querySelector('.mail-send.held') && document.querySelector(${JSON.stringify(BOX)}).value === ${JSON.stringify(words)}`, 10000).catch(() => {});
    check(`${tag}: Undo puts the words back in the box`, !(await has('.mail-send.held')) && (await page.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).value`)) === words);
    check(`${tag}: nothing went`, !(await outbox()).some((o: any) => o.state === 'sent' && o.threadId === dinner.id));
    await tap(await at(SEND));
    await page.until(`!!document.querySelector('.mail-send.held')`, 10000);
    await press('Send now');
    let mine: any = null;
    for (let i = 0; i < 60 && !mine; i++) {
      await Bun.sleep(250);
      mine = (await mailsOf(dinner.id)).find((m) => m.addressed === 'self' && !mails.some((x) => x.id === m.id));
    }
    check(`${tag}: Send now sends it into the thread, as a reply`, !!mine && mine.subject === 'Re: Dinner on Friday?', mine?.subject);
    if (mine) await page.until(`!!document.querySelector(${JSON.stringify(msg(mine.id))}) && !document.querySelector('.mail-send')`, 10000).catch(() => {});
    check(`${tag}: and the chat shows it as its message, the sending line gone`, !!mine && (await has(msg(mine.id))) && !(await has('.mail-send')));
  }
  // What went to the thread before (the box's mail, in the light run).
  const sentTo = async () => (await outbox()).filter((o: any) => o.state === 'sent' && o.threadId === dinner.id).length;
  const sentBefore = await sentTo();
  // The full editor, from the mail's menu (a long press on a phone): what the reader's Reply opened.
  // On its first words: its middle is a link, whose own menu a press there opens.
  await at(`${msg(theirs.id)} .msg-body`);
  await hold(await page.eval<Pt>(`(() => { const b = document.querySelector(${JSON.stringify(`${msg(theirs.id)} .msg-body`)}).getBoundingClientRect(); return [Math.round(b.x + 16), Math.round(b.y + 10)]; })()`));
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  await tap(await menuItem('Reply in the full editor'));
  await page.until(`!!document.querySelector('.mc-layer.phone .me-rich-doc')`, 15000);
  check(`${tag}: Reply in the full editor opens it full screen`, await inView('.mc-layer.phone .mc'));
  // The quote is the document's own text (a plain original): the attribution, then a mail quote, nested as it was.
  const filled = await page.eval<{ to: string; subject: string; quote: boolean; nested: number; island: boolean }>(
    `({ to: [...document.querySelectorAll('.mc-chip')].map((c) => c.textContent).join(','), subject: document.querySelector('.mc-subject').value, quote: /Sam Rivera <sam@rivera\\.example> wrote:$/.test([...document.querySelectorAll('.me-rich-doc > p')].find((p) => p.textContent.trim())?.textContent ?? '') && (document.querySelector('.me-rich-doc > blockquote')?.textContent ?? '').includes('Booked for 7:30'), nested: document.querySelectorAll('.me-rich-doc blockquote blockquote').length, island: !!document.querySelector('.me-island') })`,
  );
  check(`${tag}: To, the subject and the quote are filled in, the quote as text to trim or answer in`, filled.to.includes('Sam Rivera') && filled.subject === 'Re: Dinner on Friday?' && filled.quote && filled.nested === 2 && !filled.island, filled);
  // Markdown says it as Markdown does: `>` lines, a bar for each level, and `<` drawn as itself.
  await tap(await at('.me-mode', `el => el.textContent === 'Markdown'`));
  await page.until(`!!document.querySelector('.me-markdown.shown .md-quote-in2')`, 15000).catch(() => {});
  const mdQuote = await page.eval<{ text: string; levels: number }>(`({ text: (document.querySelector('.me-markdown .cm-content')?.innerText ?? '').replace(/\u2060/g, '').slice(0, 200), levels: document.querySelectorAll('.me-markdown .md-quote-in2').length })`);
  check(`${tag}: Markdown quotes it with a bar for each level, the address in <>`, mdQuote.levels > 0 && mdQuote.text.includes('<sam@rivera.example>') && !mdQuote.text.includes('&lt;'), mdQuote);
  await tap(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown .me-rich-doc blockquote')`, 10000).catch(() => {});
  check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}`);
  if (!full) {
    await tap(await at('.mc-head .icon-btn'));
    await Bun.sleep(300);
    check(`${tag}: ✕ closes it`, !(await has('.mc-layer')));
    return;
  }
  // A Bcc line opened by mistake goes away again while it is empty; Bcc beside To brings it back.
  await tap(await at('.mc-more .link-btn', `el => el.textContent === 'Bcc'`));
  check(`${tag}: an empty Bcc line has a ✕`, (await has('#mc-bcc')) && (await has('.mc-row-x[aria-label="Remove the Bcc line"]')));
  await tap(await at('.mc-row-x[aria-label="Remove the Bcc line"]'));
  check(`${tag}: ✕ takes the Bcc line away, and Bcc is offered again`, !(await has('#mc-bcc')) && (await page.eval<boolean>(`[...document.querySelectorAll('.mc-more .link-btn')].some((b) => b.textContent === 'Bcc')`)));
  // A Cc typed in, the text, a file.
  await tap(await at('.mc-more .link-btn', `el => el.textContent === 'Cc'`));
  await type('#mc-cc', 'jo@park.example');
  await key('#mc-cc', 'Enter');
  await Bun.sleep(150);
  check(`${tag}: a typed Cc becomes a chip`, await chipped('jo@park.example'));
  // Backspace at the start of the box opens the chip back into text, its last letter gone; Ctrl+Z puts it back.
  await key('#mc-cc', 'Backspace');
  await Bun.sleep(150);
  check(`${tag}: Backspace opens the chip back into text, a letter gone`, (await page.eval(`document.querySelector('#mc-cc').value`)) === 'jo@park.exampl' && !(await chipped('jo@park')));
  await key('#mc-cc', 'z', { ctrlKey: true });
  await Bun.sleep(150);
  check(`${tag}: Ctrl+Z makes it a chip again`, (await page.eval(`document.querySelector('#mc-cc').value`)) === '' && (await chipped('jo@park.example')));
  // The reply goes with its bold (Ctrl+B, as in any mail app), written where the caret starts: above the quote, on a
  // line of its own (not at the end of "… wrote:").
  await typeBody('See you at ', 'caret');
  const lines = await page.eval<string[]>(`[...document.querySelectorAll('.me-rich-doc > p')].map((p) => p.textContent)`);
  check(`${tag}: the caret starts on the line above the quote`, lines[0] === 'See you at ' && lines.some((l) => /wrote:$/.test(l)), lines.slice(0, 3));
  await press('b', 'KeyB', 66, 2);
  await page.send('Input.insertText', { text: '7:30' });
  await press('b', 'KeyB', 66, 2);
  await page.send('Input.insertText', { text: '!' });
  check(`${tag}: Ctrl+B writes bold`, (await page.eval<string>(`document.querySelector('.me-rich-doc strong')?.textContent ?? ''`)) === '7:30');
  const file = join(tmpdir(), `verify-mail-ticket-${process.pid}.txt`);
  writeFileSync(file, 'Table for two, 7:30, under Rivera.');
  await pickFile('.mc-foot input[type=file]', file);
  await page.until(`!!document.querySelector('.mc-files .composer-file[data-status="done"]')`, 15000);
  check(`${tag}: an attached file uploads`, await has('.mc-files .composer-file[data-status="done"]'));
  // Send: held, with Undo; Undo brings the draft back as it was.
  await tap(await at('.mc-send'));
  await page.until(`!document.querySelector('.mc-layer') && !!document.querySelector('.mc-strip .mc-out.held')`, 10000);
  check(`${tag}: Send closes it and says "Sending… Undo"`, (await page.eval<string>(`document.querySelector('.mc-strip').textContent`)).includes('Undo'));
  check(`${tag}: no sideways overflow: the strip`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}-held`);
  await tap(await at('.mc-strip .mc-undo'));
  await page.until(`(document.querySelector('.me-rich-doc')?.innerText ?? '').startsWith('See you at 7:30!')`, 10000);
  check(`${tag}: Undo brings the draft back, file and all`, (await has('.mc-files .composer-file')) && (await chipped('jo@park.example')));
  check(`${tag}: nothing went`, (await sentTo()) === sentBefore);
  // Send again, and let it go.
  await tap(await at('.mc-send'));
  await page.until(`!!document.querySelector('.mc-strip .mc-out')`, 10000);
  const end = Date.now() + 30_000;
  while (Date.now() < end && (await sentTo()) === sentBefore) await Bun.sleep(250);
  await page.until(`!!document.querySelector('.mc-strip .mc-out.sent')`, 5000).catch(() => {});
  check(`${tag}: then "Sent"`, await has('.mc-strip .mc-out.sent'));
  // Yours, with its Cc (Sam answers it by himself a few seconds later, so it is found by being yours and new).
  let mine: any = null;
  for (let end2 = Date.now() + 10_000; Date.now() < end2 && !mine; ) {
    mine = (await mailsOf(dinner.id)).find((m) => m.addressed === 'self' && !mails.some((x) => x.id === m.id) && m.cc.some((a: any) => a.email === 'jo@park.example'));
    if (!mine) await Bun.sleep(250);
  }
  check(`${tag}: the reply joins the thread, with its Cc and its file`, !!mine && mine.hasAttachments, { cc: mine?.cc, files: mine?.hasAttachments });
  if (!mine) return;
  // With Jo on it the thread is no longer Sam's alone: it leaves his chat for one of its own (docs/mail.md "Where a
  // thread goes"), where the reply shows.
  await page.until(`!document.querySelector(${JSON.stringify(msg(booked.id))})`, 10000).catch(() => {});
  check(`${tag}: with Jo on it, the thread leaves Sam's chat`, !(await has(msg(booked.id))));
  // Its HTML part is plain (no colours or fonts) but formatted (bold): it reads as its HTML in the app's theme, not on a white sheet.
  const body = (await fetch(`${base}/api/mail/messages/${mine.id}/body`).then((r) => r.json())) as any;
  check(`${tag}: the hub calls its HTML plain and formatted`, !!body.html && body.html.plain === true && body.html.formatted === true, body.html);
  // An empty line goes as one mail apps draw (`<p><br></p>`), never as an empty <p>; the text part's quote has no Markdown escapes.
  const wentHtml = body.html ? await fetch(`${base}${body.html.url}`).then((r) => r.text()) : '';
  check(`${tag}: no empty <p> went, and the text part's quote reads as it was written`, !!body.text && !/<p[^>]*><\/p>/.test(wentHtml) && !/\\[_*[\]]/.test(body.text) && !/\]\(https?:/.test(body.text), { text: String(body.text).slice(0, 400) });
  for (const t of [themeName, themeName === 'dither-dark' ? 'dither-light' : 'dither-dark']) {
    await theme(t, `#/inbox/c/${dinner.id}?m=${mine.id}`);
    const card = msg(mine.id);
    await page.until(`!!document.querySelector(${JSON.stringify(card)})`, 10000);
    check(`composer phone ${t}: the thread's own chat shows your reply`, await has(`.mail-thread-pane ${card}`));
    // The reader folded it to a line; the chat draws its words, and its HTML behind ··· as "Show as sent".
    const said = await page.eval<string>(`document.querySelector('${card} .mail-words')?.textContent ?? ''`);
    // As its text part says them (mail is never drawn as Markdown: the bold is its stars there).
    check(`composer phone ${t}: your reply's words in the chat, as its text part has them`, said.startsWith('See you at **7:30**!') && String(body.text).startsWith(said.split('\n')[0]), said.slice(0, 120));
    await tap(await at(`${card} .mail-quote-dots`));
    await tap(await at(`${card} .mail-open-chip`, `el => el.textContent.includes('Show as sent')`));
    await page.until(`!!document.querySelector('${card} .chat-mail-sent .mail-html.ready')`, 10000).catch(() => {});
    const shown = await page.eval<{ bold: string; bg: string; fold: boolean; text: string; app: string }>(
      `(() => { const c = document.querySelector('${card}'); const d = c?.querySelector('.mail-sheet.themed iframe')?.contentDocument; const rgb = (v) => { const e = document.createElement('i'); e.style.color = v; document.body.append(e); const x = getComputedStyle(e).color; e.remove(); return x; }; return { bold: d?.querySelector('strong')?.textContent ?? '', bg: d ? getComputedStyle(d.body).backgroundColor : '', fold: !!d?.querySelector('.dc-fold'), text: d ? getComputedStyle(d.querySelector('.dc-mail')).color : '', app: rgb(getComputedStyle(document.documentElement).getPropertyValue('--text')) }; })()`,
    );
    check(`composer phone ${t}: as sent, a formatted reply shows its bold in the app's theme (its colours, no white sheet), its quote folded`, shown.bold === '7:30' && shown.bg === 'rgba(0, 0, 0, 0)' && shown.text === shown.app && shown.fold, shown);
    await page.eval(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
    await shot(`mail-composer-phone-${t}-formatted-reply`);
  }
}

async function composerDesktop(themeName: string, full: boolean) {
  const tag = `composer desktop ${themeName}`;
  await page.size(1400, 900);
  await theme(themeName, inList('v:all:*'));
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 15000);
  // Mail's ✎ is gone with its page: the Inbox's + (New message) has New email.
  await click(await at('.sidebar .side-new'));
  await page.until(`[...document.querySelectorAll('.switcher-row')].some((r) => r.textContent.includes('New email'))`, 5000);
  await click(await at('.switcher-row', `el => el.textContent.includes('New email')`));
  await page.until(`!!document.querySelector('.mc-layer.dock #mc-to')`, 15000);
  const box = await page.eval<{ right: number; bottom: number; w: number }>(`(() => { const r = document.querySelector('.mc-layer.dock .mc').getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, w: r.width }; })()`);
  check(`${tag}: New email docks a new message at the bottom right`, box.right >= 0 && box.right < 40 && box.bottom >= 0 && box.bottom < 40 && box.w < 700, box);
  check(`${tag}: the list stays usable beside it`, await inView('.sidebar .mail-row'));
  check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}`);
  if (!full) {
    await click(await at('.mc-discard'));
    await Bun.sleep(300);
    check(`${tag}: discard closes it`, !(await has('.mc-layer')));
    return;
  }
  // To completes from the people in your mail.
  await type('#mc-to', 'sam');
  await page.until(`document.querySelectorAll('.mc-hits li').length > 0`, 5000).catch(() => {});
  check(`${tag}: To completes from your mail`, (await page.eval<string>(`document.querySelector('.mc-hits')?.textContent ?? ''`)).includes('sam@rivera.example'));
  await page.eval(`document.querySelector('.mc-hits li').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await Bun.sleep(150);
  check(`${tag}: picking one makes a chip`, await chipped('Sam'));
  // And from the account's own server (mail.contacts; the demo's address book): someone no mail here names.
  await type('#mc-to', 'dana');
  await page.until(`[...document.querySelectorAll('.mc-hits li')].some((l) => l.textContent.includes('dana@okafor.example'))`, 6000).catch(() => {});
  check(`${tag}: To completes from the account's server too`, (await page.eval<string>(`document.querySelector('.mc-hits')?.textContent ?? ''`)).includes('Dana Okafor'));
  await key('#mc-to', 'Enter');
  await Bun.sleep(150);
  check(`${tag}: Enter takes the suggestion`, await chipped('Dana Okafor'));
  // A click on a chip opens it to edit, whole; Enter puts it back where it was.
  await click(await at('.mc-chip-name', `el => el.textContent.includes('Sam')`));
  await Bun.sleep(150);
  check(`${tag}: a click opens a chip to edit, whole`, (await page.eval(`document.querySelector('#mc-to').value`)) === 'sam@rivera.example');
  await key('#mc-to', 'Enter');
  await Bun.sleep(150);
  check(`${tag}: Enter puts it back where it was, with its name`, (await page.eval<string[]>(`[...document.querySelectorAll('.mc-chip-name')].map((c) => c.textContent)`)).join(',') === 'Sam Rivera,Dana Okafor');
  // Resized by its bottom right corner with the mouse: the top left stays put.
  const rect = () => page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('.mc-layer.dock').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  const was = await rect();
  const [gx, gy] = await at('.mc-grip.se');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx, y: gy, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gx, y: gy, button: 'left', buttons: 1, clickCount: 1 });
  for (const k of [1, 2, 3]) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: gx - 20 * k, y: gy - 30 * k, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gx - 60, y: gy - 90, button: 'left', buttons: 0, clickCount: 1 });
  await Bun.sleep(150);
  const now = await rect();
  check(`${tag}: the bottom right corner resizes it, the top left staying`, now.x === was.x && now.y === was.y && now.w === was.w - 60 && now.h === was.h - 90, { was, now });
  // Maximized: the window but a gap; again: back to that size.
  await click(await at('.mc-max'));
  const big = await rect();
  check(`${tag}: maximize fills the window`, big.x === 16 && big.y === 16 && big.w === 1400 - 32 && big.h === 900 - 32, big);
  await shot(`mail-${tag.replace(/ /g, '-')}-maximized`);
  await click(await at('.mc-max'));
  const back = await rect();
  check(`${tag}: and back to the size it was`, back.w === now.w && back.h === now.h && back.x === now.x, back);
  // A screenshot pasted into the text goes in place; pasted elsewhere (the subject) it is attached, with a name.
  const paste = (sel: string) =>
    page.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    const g = c.getContext('2d'); g.fillStyle = '#c63'; g.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    const t = document.querySelector(${JSON.stringify(sel)}); t.focus();
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await page.until(`!!document.querySelector('.me-rich-doc')`, 15000);
  await paste('.me-rich-doc');
  await page.until(`!!document.querySelector('.me-rich-doc img[src^="data:image/png"]')`, 8000).catch(() => {});
  check(`${tag}: a picture pasted into the text sits in the text, not attached`, (await has('.me-rich-doc img[src^="data:image/png"]')) && !(await has('.mc-files .composer-file')));
  await paste('#mc-subject');
  await page.until(`!!document.querySelector('.mc-files .composer-file[data-status="done"] img')`, 15000).catch(() => {});
  const pasted = await page.eval<{ name: string; img: boolean }>(`(() => { const f = document.querySelector('.mc-files .composer-file'); return { name: f?.querySelector('.composer-file-name')?.textContent ?? '', img: !!f?.querySelector('img')?.naturalWidth }; })()`);
  check(`${tag}: pasted outside the text, it is attached with its thumbnail and a name`, /^Pasted picture \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/.test(pasted.name) && pasted.img, pasted);
  check(`${tag}: the size counts the picture in the text`, /^≈ \d/.test(await page.eval<string>(`document.querySelector('.mc-size-btn')?.textContent ?? ''`)));
  // A file dropped on it is attached too.
  await page.eval(`(() => {
    const dt = new DataTransfer(); dt.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
    const m = document.querySelector('.mc-scroll');
    for (const type of ['dragenter', 'dragover', 'drop']) m.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  await page.until(`[...document.querySelectorAll('.mc-files .composer-file-name')].some((n) => n.textContent === 'notes.txt')`, 15000).catch(() => {});
  check(`${tag}: a dropped file is attached`, await page.eval<boolean>(`[...document.querySelectorAll('.mc-files .composer-file-name')].some((n) => n.textContent === 'notes.txt')`));
  await shot(`mail-${tag.replace(/ /g, '-')}-pasted`);
  // Taken off again, so the draft below is as it was.
  for (let i = 0; i < 2; i++) await click(await at('.mc-files .composer-file .icon-btn[aria-label^="Remove"]'));
  await type('#mc-subject', 'Photos from Friday');
  await typeBody('Here they are.');
  // The bar shows by default; B makes the selection bold; the Markdown and HTML views show it; Ctrl+Z takes it back.
  check(`${tag}: the formatting bar shows`, await has('.me-bar .mc-fmt-bold'));
  await selectWord('they');
  await click(await at('.mc-fmt-bold'));
  await Bun.sleep(150);
  check(`${tag}: B makes the selection bold`, (await page.eval(`document.querySelector('.me-rich-doc strong')?.textContent ?? ''`)) === 'they');
  await click(await at('.me-mode', `el => el.textContent === 'Markdown'`));
  await page.until(`!!document.querySelector('.me-markdown.shown .cm-content')`, 15000).catch(() => {});
  const md = await page.eval<string>(`[...document.querySelectorAll('.me-markdown .cm-line')].map((l) => l.textContent).join('\\n')`);
  // Live: the bold shows bold, its ** marks shown only on the caret's line.
  check(`${tag}: the Markdown view says it as Markdown, drawn as it will look`, md.replace(/\*\*/g, '') === 'Here they are.' && (await page.eval(`document.querySelector('.me-markdown .md-strong')?.textContent.replace(/\\*/g, '') ?? ''`)) === 'they', md);
  await shot(`mail-${tag.replace(/ /g, '-')}-markdown`);
  await click(await at('.me-mode', `el => el.textContent === 'HTML'`));
  await page.until(`document.querySelector('.me-html-preview iframe')?.contentDocument?.querySelector('strong')?.textContent === 'they'`, 15000).catch(() => {});
  check(`${tag}: the HTML view shows the HTML and the mail as it arrives`, (await page.eval(`document.querySelector('.me-html .cm-content')?.textContent ?? ''`)).includes('<strong>they</strong>') && (await page.eval(`document.querySelector('.me-html-preview iframe')?.contentDocument?.querySelector('strong')?.textContent ?? ''`)) === 'they');
  check(`${tag}: no sideways overflow: the HTML view`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}-html`);
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown')`, 5000).catch(() => {});
  check(`${tag}: back in Rich, nothing lost`, (await bodyText()) === 'Here they are.' && (await page.eval(`document.querySelector('.me-rich-doc strong')?.textContent ?? ''`)) === 'they', await bodyText());
  await page.eval(`document.querySelector('.me-rich-doc').focus()`);
  await press('z', 'KeyZ', 90, 2);
  await Bun.sleep(150);
  check(`${tag}: Ctrl+Z takes the bold back`, !(await has('.me-rich-doc strong')) && (await bodyText()) === 'Here they are.', await bodyText());
  // More of the bar: a list item nests with Tab and its button shows pressed; Heading; Remove formatting; a table.
  // "- " starts a list as it is typed.
  await typeBody('-');
  await page.send('Input.insertText', { text: ' ' });
  await page.send('Input.insertText', { text: 'one' });
  await press('Enter', 'Enter', 13);
  await page.send('Input.insertText', { text: 'two' });
  await press('Tab', 'Tab', 9);
  await Bun.sleep(150);
  check(`${tag}: Tab nests a list item`, (await page.eval(`document.querySelector('.me-rich-doc ul ul li')?.textContent ?? ''`)) === 'two');
  await page.until(`document.querySelector('.me-bar .mc-fmt-bullets')?.getAttribute('aria-pressed') === 'true'`, 3000).catch(() => {});
  check(`${tag}: the bullets button shows pressed in a list`, (await page.eval(`document.querySelector('.me-bar .mc-fmt-bullets').getAttribute('aria-pressed')`)) === 'true');
  await press('Tab', 'Tab', 9, 8);
  await Bun.sleep(150);
  check(`${tag}: Shift+Tab takes it back out`, !(await has('.me-rich-doc ul ul')) && (await page.eval<number>(`document.querySelectorAll('.me-rich-doc ul li').length`)) === 2);
  // Heading, Remove formatting, colour, code, alignment and tables are behind ⋯, which keeps the bar to one row.
  check(`${tag}: the less used buttons wait behind ⋯`, !(await has('.me-bar .mc-fmt-heading')) && !(await has('.me-bar .mc-fmt-table')) && (await has('.me-bar .me-more')));
  await click(await at('.me-more'));
  await typeBody('Plan for Friday');
  await click(await at('.mc-fmt-heading'));
  check(`${tag}: Heading makes the line a heading`, (await page.eval(`document.querySelector('.me-rich-doc h1')?.textContent ?? ''`)) === 'Plan for Friday');
  await click(await at('.mc-fmt-clear'));
  check(`${tag}: Remove formatting takes the heading off`, !(await has('.me-rich-doc h1')) && (await bodyText()) === 'Plan for Friday');
  await typeBody('Plan:');
  await press('Enter', 'Enter', 13);
  await click(await at('.mc-fmt-table'));
  await page.until(`!!document.querySelector('.me-rich-doc table')`, 3000).catch(() => {});
  await page.send('Input.insertText', { text: 'Day' });
  await click(await at('.me-mode', `el => el.textContent === 'HTML'`));
  await page.until(`!!document.querySelector('.me-html-preview iframe')?.contentDocument?.querySelector('th')`, 15000).catch(() => {});
  const cell = await page.eval<{ th: string; border: string }>(`(() => { const d = document.querySelector('.me-html-preview iframe')?.contentDocument; const td = d?.querySelector('td'); return { th: d?.querySelector('th')?.textContent ?? '', border: td ? getComputedStyle(td).borderTopWidth + ' ' + getComputedStyle(td).borderTopStyle : '' }; })()`);
  check(`${tag}: a table goes with its lines`, cell.th.trim() === 'Day' && cell.border === '1px solid', cell);
  await shot(`mail-${tag.replace(/ /g, '-')}-table`);
  // An edit in the HTML view brings the table back as a table, not a sealed block of HTML.
  await page.eval(`document.querySelector('.me-html .cm-content').focus()`);
  await press('End', 'End', 35, 2);
  await page.send('Input.insertText', { text: '\n<p>After the table</p>' });
  await Bun.sleep(500);
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown')`, 5000).catch(() => {});
  check(`${tag}: edited in HTML, a table comes back a table`, (await has('.me-rich-doc table')) && !(await has('.me-rich-doc .me-island')) && (await bodyText()).includes('After the table'), await bodyText());
  // Alignment survives an edit in the Markdown view (written there as a small piece of HTML).
  await typeBody('Centred');
  await click(await at('.mc-fmt-align'));
  await click(await at('.me-mode', `el => el.textContent === 'Markdown'`));
  await page.until(`!!document.querySelector('.me-markdown.shown .cm-content')`, 15000).catch(() => {});
  await page.eval(`document.querySelector('.me-markdown .cm-content').focus()`);
  await press('End', 'End', 35, 2);
  await page.send('Input.insertText', { text: '\n\nNext' });
  await Bun.sleep(500);
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown')`, 5000).catch(() => {});
  check(`${tag}: edited in Markdown, centred text stays centred`, (await page.eval(`document.querySelector('.me-rich-doc p[style*="center"]')?.textContent ?? ''`)) === 'Centred', await page.eval(`document.querySelector('.me-rich-doc').innerHTML.slice(0, 300)`));
  // Plain: the fourth view, plain text only, kept with the draft; no pictures choice; Rich again undoes it.
  await click(await at('.me-mode', `el => el.textContent === 'Plain'`));
  await page.until(`!!document.querySelector('.me-plain.shown .cm-content')`, 15000).catch(() => {});
  const plainDraft = async () => ((await fetch(`${base}/api/mail/drafts`).then((r) => r.json())) as any).drafts.find((x: any) => x.draft.subject === 'Photos from Friday')?.draft;
  let pd: any = null;
  for (let i = 0; i < 30 && !pd?.plainOnly; i++) (await Bun.sleep(200), (pd = await plainDraft()));
  check(`${tag}: Plain shows the text as it goes, with no formatting buttons, and the draft says plain text only`, !!pd?.plainOnly && !(await has('.me-bar .mc-fmt-bold')) && (await page.eval<string>(`document.querySelector('.me-plain .cm-content')?.textContent ?? ''`)).includes('Centred'), pd?.plainOnly);
  // The centred line is a piece of HTML in Markdown; plain text has it as words only.
  const plainShown = await page.eval<string>(`document.querySelector('.me-plain .cm-content')?.textContent ?? ''`);
  check(`${tag}: Plain has no HTML tags in it`, !/<\/?[a-z][^>]*>/i.test(plainShown), plainShown.slice(0, 200));
  await shot(`mail-${tag.replace(/ /g, '-')}-plain`);
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown')`, 5000).catch(() => {});
  for (let i = 0; i < 30 && pd?.plainOnly; i++) (await Bun.sleep(200), (pd = await plainDraft()));
  check(`${tag}: back to Rich, it is HTML again`, pd?.plainOnly === false || pd?.plainOnly === undefined, pd?.plainOnly);
  await typeBody('Here they are.');
  // Closed: kept as a draft, which the Drafts line opens again.
  await Bun.sleep(300);
  await click(await at('.mc-head .icon-btn'));
  await page.until(`!!document.querySelector('.mail-drafts-line')`, 8000).catch(() => {});
  const draftsLine = await page.eval<string>(`document.querySelector('.mail-drafts-line')?.textContent ?? ''`);
  check(`${tag}: closing keeps a draft`, draftsLine.includes('1 draft'), { draftsLine, drafts: ((await fetch(`${base}/api/mail/drafts`).then((r) => r.json())) as any).drafts.map((d: any) => [d.key, d.draft.kind, d.draft.subject, d.draft.text.slice(0, 40), d.draft.html?.slice(0, 80)]) });
  await click(await at('.mail-drafts-line'));
  await click(await at('.cm-item, .context-menu button, [role=menuitem]', `el => el.textContent.includes('Photos from Friday')`));
  await page.until(`(document.querySelector('.me-rich-doc')?.innerText ?? '').trim() === 'Here they are.'`, 8000).catch(() => {});
  check(`${tag}: the draft opens again as it was`, (await page.eval(`document.querySelector('.mc-subject')?.value`)) === 'Photos from Friday' && (await bodyText()) === 'Here they are.');
  // Discarded: Undo in the strip brings it back; once that is over, the draft is gone.
  await click(await at('.mc-discard'));
  await page.until(`!document.querySelector('.mc-layer') && !!document.querySelector('.mc-out.discarded .mc-undo')`, 8000).catch(() => {});
  check(`${tag}: discarding offers Undo, and the Drafts line leaves it out`, (await has('.mc-out.discarded .mc-undo')) && !(await has('.mail-drafts-line')));
  await click(await at('.mc-out.discarded .mc-undo'));
  await page.until(`(document.querySelector('.me-rich-doc')?.innerText ?? '').trim() === 'Here they are.'`, 8000).catch(() => {});
  check(`${tag}: Undo brings the discarded draft back`, (await bodyText()) === 'Here they are.');
  await click(await at('.mc-discard'));
  await Bun.sleep(9_500);
  const left = ((await fetch(`${base}/api/mail/drafts`).then((r) => r.json())) as any).drafts as any[];
  check(`${tag}: after its Undo, the draft is gone`, !(await has('.mail-drafts-line')) && !(await has('.mc-out.discarded')) && !left.length, left.length);
  await forwardWithPictures(tag);
  await leftAsLeft(tag);
}

/** A reply emptied on purpose stays empty when it is opened again. */
async function leftAsLeft(tag: string) {
  const [, , jo] = await mailsOf(lease.id);
  await page.eval(`location.hash = ${JSON.stringify(inList('v:all:*', lease.id))}`);
  await page.until(`!!document.querySelector(${JSON.stringify(`.mail-thread-pane ${msg(jo.id)}`)})`, 15000);
  // The reader's Reply is the chat's box; the full editor, where a reply can be emptied, is in the mail's menu.
  const reply = async () => {
    await openMenuOn(`${msg(jo.id)} .msg-body`);
    await click(await menuItem('Reply all in the full editor'));
    await page.until(`!!document.querySelector('.me-rich-doc')`, 15000);
    await Bun.sleep(600);
  };
  await reply();
  check(`${tag}: a reply starts with its quote`, (await has('.me-rich-doc blockquote')) || (await has('.me-island')));
  await typeBody('');
  await page.until(`!document.querySelector('.me-rich-doc blockquote, .me-island')`, 5000).catch(() => {});
  await Bun.sleep(1200);
  await click(await at('.mc-head .icon-btn', `el => (el.getAttribute('aria-label') ?? '').startsWith('Close')`));
  await page.until(`!document.querySelector('.mc-layer')`, 5000).catch(() => {});
  await reply();
  check(`${tag}: emptied and closed, it opens again empty, with "Quote" to put the quote back`, !(await has('.me-rich-doc blockquote')) && !(await has('.me-island')) && (await has('.mc-quote-add')));
  await click(await at('.mc-discard'));
  // Its "Discarded · Undo" strip gone, and the draft with it: nothing left over for the checks after.
  await page.until(`!document.querySelector('.mc-layer') && !document.querySelector('.mc-out.discarded')`, 15000).catch(() => {});
  check(`${tag}: discarded, the emptied reply is gone`, !(await has('.mc-out.discarded')));
}

/** A big newsletter forwarded: its layout comes along, trackers gone; Embed sends its pictures inside the mail. */
async function forwardWithPictures(tag: string) {
  const sale = (await page1('v:updates:*')).find((t) => t.subject.includes('winter sale'));
  if (!sale) return check(`${tag}: the store newsletter is in Updates`, false);
  const [news] = await mailsOf(sale.id);
  const card = msg(news.id);
  await page.eval(`location.hash = ${JSON.stringify(inList('v:updates:*', sale.id))}`);
  await page.until(`!!document.querySelector(${JSON.stringify(`${card} .mail-quote-dots`)})`, 15000);
  // The reader showed a newsletter's HTML; a chat shows its words, and the HTML behind ··· as "Show as sent".
  await click(await at(`${card} .mail-quote-dots`));
  await click(await at(`${card} .mail-open-chip`, `el => el.textContent.includes('Show as sent')`));
  // Its HTML drawn (the frame grows as it lays out, moving what is below it).
  await page.until(`!!document.querySelector(${JSON.stringify(`${card} .chat-mail-sent .mail-html.ready`)})`, 15000);
  // Its picture bar: this mail's own choice (none, the ones unlikely to tell, all), from ⋯.
  await click(await at('.mail-img-more'));
  const picMenu = await page.eval<string[]>(`[...document.querySelectorAll('[role=menuitemradio]')].map((e) => e.textContent.trim())`);
  check(`${tag}: the picture bar's ⋯ offers this mail none, only the ones unlikely to tell, or all`, ['No pictures', 'Only the ones unlikely to tell', 'All pictures'].every((x) => picMenu.includes(x)), picMenu);
  // A choice serves the mail again: its frame loads the new page and lays out, moving what is around it.
  const frameSrc = `document.querySelector('${card} .mail-frame')?.src ?? ''`;
  const redrawn = async (before: string) =>
    page.until(`${frameSrc} !== ${JSON.stringify(before)} && !!document.querySelector('${card} .mail-html.ready')`, 10000).catch(() => {});
  let before = await page.eval<string>(frameSrc);
  await click(await at('[role=menuitemradio]', `el => el.textContent.trim() === 'No pictures'`));
  await page.until(`/not loaded/.test(document.querySelector('.mail-img-banner')?.textContent ?? '')`, 8000).catch(() => {});
  await redrawn(before);
  check(`${tag}: No pictures, for this mail only`, /not loaded/.test(await page.eval<string>(`document.querySelector('.mail-img-banner')?.textContent ?? ''`)));
  await click(await at('.mail-img-more'));
  before = await page.eval<string>(frameSrc);
  await click(await at('[role=menuitem]', `el => el.textContent.trim() === 'Back to the usual'`));
  await page.until(`!/not loaded|your choice/.test(document.querySelector('.mail-img-banner')?.textContent ?? '')`, 8000).catch(() => {});
  await redrawn(before);
  // Forward, from the mail's menu, on its words again.
  await click(await at(`${card} .mail-open-chip`, `el => el.textContent.includes('Just the words')`));
  await page.until(`!!document.querySelector(${JSON.stringify(`${card} .msg-body`)})`, 5000);
  await openMenuOn(`${card} .msg-body`);
  await click(await menuItem('Forward'));
  await page.until(`!!document.querySelector('.me-island[data-kind="forward"] iframe')?.contentDocument?.querySelector('img[data-dc-src]')`, 15000).catch(() => {});
  const isl = await page.eval<{ styled: boolean; pictures: number; trackers: number }>(`(() => { const d = document.querySelector('.me-island[data-kind="forward"] iframe')?.contentDocument; return { styled: !!d?.querySelector('.card[style*="border"]'), pictures: d?.querySelectorAll('img[data-dc-src]').length ?? 0, trackers: d ? [...d.querySelectorAll('img[data-dc-src]')].filter((i) => /track|\\/o\\//.test(i.dataset.dcSrc)).length : -1 }; })()`);
  check(`${tag}: a forward keeps its layout (style sheets inlined), its pictures, and none of its trackers`, isl.styled && isl.pictures > 60 && isl.trackers === 0, isl);
  // The footer says how its pictures from the web go, in sight however long the forward is; it opens the choice.
  // The hub's answer on which can tell (the newsletter's personal header) comes after the button draws, and widens it.
  await page.until(`!!document.querySelector('.mc-foot .mc-pics-btn .mc-seg-warn')`, 10000).catch(() => {});
  const picsBtn = await page.eval<string>(`document.querySelector('.mc-foot .mc-pics-btn')?.textContent ?? ''`);
  // Link leaves out the one that can tell unless asked: the footer counts what goes.
  check(`${tag}: the footer says how its pictures from the web go, and that the one that can tell is left out`, /^69 · Link · 1 left out$/.test(picsBtn), picsBtn);
  // The editor shows it: the one left out is faded in the forward, the rest as they are.
  const outIn = `document.querySelector('.me-island[data-kind="forward"] iframe')?.contentDocument?.querySelectorAll('img.dc-out').length ?? -1`;
  await page.until(`${outIn} === 1`, 5000).catch(() => {});
  check(`${tag}: the forward marks the picture Link leaves out`, (await page.eval<number>(outIn)) === 1, await page.eval<number>(outIn));
  // Plain shows the forward's text as it goes, not a chip.
  await click(await at('.me-mode', `el => el.textContent === 'Plain'`));
  await page.until(`!!document.querySelector('.me-plain.shown .md-island-text')`, 15000).catch(() => {});
  const plainFwd = await page.eval<string>(`document.querySelector('.me-plain .md-island-text')?.textContent ?? ''`);
  check(`${tag}: Plain shows the forwarded message's text`, plainFwd.includes('Forwarded message') && plainFwd.includes('Northbound Outfitters'), plainFwd.slice(0, 160));
  check(`${tag}: Plain's forward can be taken out there`, await has('.me-plain .md-island-text .md-island-x'));
  // Taken out in Plain and put back: Rich again, and an HTML part again (the pictures choice is back).
  await click(await at('.me-plain .md-island-x'));
  await page.until(`!document.querySelector('.me-plain .md-island-text') && !!document.querySelector('.mc-quote-add')`, 5000).catch(() => {});
  await click(await at('.mc-quote-add'));
  await page.until(`!!document.querySelector('.me-rich.shown .me-island[data-kind="forward"]') && !!document.querySelector('.mc-pics-btn')`, 10000).catch(() => {});
  check(`${tag}: put back from Plain, the forward goes as HTML again`, (await has('.me-rich.shown .me-island[data-kind="forward"]')) && (await has('.mc-pics-btn')));
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown') && !!document.querySelector('.mc-pics-btn')`, 10000).catch(() => {});
  await click(await at('.mc-pics-btn'));
  check(`${tag}: under Link, leaving out the one that can tell is on`, await page.eval<boolean>(`!!document.querySelector('.mc-pics-tell input')?.checked`));
  check(`${tag}: it opens the choice`, (await page.eval<string>(`document.querySelector('.mc-pics-pop')?.textContent ?? ''`)).includes('pictures from the web'));
  const linkLabel = await page.eval<string>(`[...document.querySelectorAll('.mc-seg-btn')].find((b) => b.textContent.startsWith('Link'))?.textContent ?? ''`);
  check(`${tag}: Link says on itself how many pictures can tell the original sender`, linkLabel === 'Link · 1 can tell', linkLabel);
  await click(await at('.mc-seg-btn', `el => el.textContent === 'Embed'`));
  const embedBtn = await page.eval<string>(`document.querySelector('.mc-pics-btn')?.textContent ?? ''`);
  check(`${tag}: the footer button follows the choice and counts what goes`, embedBtn === '69 · Embed · 1 left out', embedBtn);
  await click(await at('.mc-seg-btn', `el => el.textContent === 'Leave out'`));
  const allIn = `document.querySelector('.me-island[data-kind="forward"] iframe')?.contentDocument?.querySelectorAll('img[data-dc-src]').length ?? -2`;
  await page.until(`${outIn} === ${allIn}`, 5000).catch(() => {});
  const dropBtn = await page.eval<string>(`document.querySelector('.mc-pics-btn')?.textContent ?? ''`);
  const marked = { dropBtn, out: await page.eval<number>(outIn), all: await page.eval<number>(allIn) };
  check(`${tag}: Leave out marks every picture from the web, and the footer counts none going`, dropBtn === '0 · Leave out' && marked.out === marked.all && marked.all > 60, marked);
  // A picture pasted with an address that has no scheme (//host) is a box in the text, marked left out like the rest;
  // a click picks it (drawn so), and Backspace takes it out again.
  await page.eval(`(() => {
    const dt = new DataTransfer(); dt.setData('text/html', '<p><img src="//pixel.example/o.gif?u=7" width="80" height="20"></p>');
    const t = document.querySelector('.me-rich-doc'); t.focus();
    t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  const bare = `document.querySelector('.me-rich-doc .me-pic-web[data-dc-was^="//pixel.example"]')`;
  await page.until(`!!${bare}?.classList.contains('dc-out')`, 5000).catch(() => {});
  check(`${tag}: a pasted picture whose address has no scheme is marked left out too`, await page.eval<boolean>(`!!${bare}?.classList.contains('dc-out')`));
  await click(await at('.me-rich-doc .me-pic-web[data-dc-was^="//pixel.example"]'));
  const picked = await page.eval<string>(`(() => { const b = ${bare}; return b?.classList.contains('ProseMirror-selectednode') ? getComputedStyle(b).outlineStyle : 'not picked'; })()`);
  check(`${tag}: a click picks a picture box, and it shows it is picked`, picked === 'solid', picked);
  await press('Backspace', 'Backspace', 8);
  await page.until(`!${bare}`, 3000).catch(() => {});
  check(`${tag}: Backspace takes the picked box out`, !(await has('.me-rich-doc .me-pic-web[data-dc-was^="//pixel.example"]')));
  // The click in the text closed the choice: open it again.
  await click(await at('.mc-pics-btn'));
  await click(await at('.mc-seg-btn', `el => el.textContent === 'Embed'`));
  // The one that can tell was held in the reader, so the hub has not got it: Embed leaves it out rather than fetch it.
  const embedNote = await page.eval<string>(`document.querySelector('.mc-pics-note')?.textContent ?? ''`);
  check(`${tag}: Embed says it leaves out the picture that can tell`, embedNote.includes('1 picture that can tell is left out'), embedNote);
  await click(await at('.mc-size-btn'));
  check(`${tag}: the size breakdown counts the embedded pictures`, (await page.eval<string>(`document.querySelector('.mc-size-pop')?.textContent ?? ''`)).includes('embedded'));
  await shot(`mail-${tag.replace(/ /g, '-')}-forward`);
  await click(await at('.mc-size-btn'));
  // The newsletter is kept whole (its layout is its own HTML): Edit HTML opens its HTML under its bar, Done closes it,
  // and only opening it changes nothing that goes.
  const sizeBefore = await page.eval<string>(`document.querySelector('.mc-size-btn')?.textContent ?? ''`);
  await click(await at('.me-island[data-kind="forward"] .me-island-btn', `el => el.textContent === 'Edit HTML'`));
  await page.until(`!!document.querySelector('.me-island[data-kind="forward"] .me-island-code .cm-content')`, 15000).catch(() => {});
  const nested = await page.eval<{ open: boolean; above: boolean; text: string }>(
    `(() => { const i = document.querySelector('.me-island[data-kind="forward"]'); const c = i?.querySelector('.me-island-code'); return { open: !!c?.querySelector('.cm-content') && !c.hidden, above: !!c && c.compareDocumentPosition(i.querySelector('.me-island-sheet')) === Node.DOCUMENT_POSITION_FOLLOWING, text: c?.querySelector('.cm-content')?.textContent.slice(0, 200) ?? '' }; })()`,
  );
  check(`${tag}: a forward kept whole opens its own HTML editor in place, over the forward`, nested.open && nested.above && nested.text.includes('dc-forward-head'), nested);
  await click(await at('.me-island[data-kind="forward"] .me-island-btn', `el => el.textContent === 'Done'`));
  await Bun.sleep(400);
  check(`${tag}: Done closes it, and the mail is as it was`, (await page.eval<boolean>(`document.querySelector('.me-island[data-kind="forward"] .me-island-code').hidden`)) && (await page.eval<string>(`document.querySelector('.mc-size-btn')?.textContent ?? ''`)) === sizeBefore);
  // Make it text turns the block into the document's text, the caret at its start in sight; Undo brings it back.
  await click(await at('.me-island[data-kind="forward"] .me-island-btn', `el => el.textContent === 'Make it text'`));
  await page.until(`!document.querySelector('.me-island')`, 5000).catch(() => {});
  const made = await page.eval<{ island: boolean; text: boolean; top: number }>(
    `({ island: !!document.querySelector('.me-island'), text: (document.querySelector('.me-rich-doc')?.innerText ?? '').includes('Forwarded message'), top: document.querySelector('.me-rich-doc')?.closest('.mc-scroll')?.scrollTop ?? -1 })`,
  );
  check(`${tag}: Make it text makes the forward text, the caret at its start`, !made.island && made.text && made.top >= 0 && made.top < 600, made);
  await press('z', 'KeyZ', 90, 2);
  await page.until(`!!document.querySelector('.me-island[data-kind="forward"]')`, 5000).catch(() => {});
  check(`${tag}: Undo brings the block back`, await has('.me-island[data-kind="forward"]'));
  // Markdown draws it as it arrives, under a bar that names it: not a stand-in.
  await click(await at('.me-mode', `el => el.textContent === 'Markdown'`));
  await page.until(`!!document.querySelector('.me-markdown.shown .md-island-sheet iframe')`, 15000).catch(() => {});
  const sheetBar = await page.eval<string>(`document.querySelector('.me-markdown .md-island-sheet-bar')?.textContent ?? ''`);
  check(`${tag}: Markdown shows the forward kept whole as it arrives, named as its own HTML first`, sheetBar.startsWith('Kept as its own HTML') && sheetBar.includes('Open in HTML view') && (await has('.me-markdown .md-island-sheet iframe')), sheetBar);
  await click(await at('.me-mode', `el => el.textContent === 'Rich'`));
  await page.until(`!!document.querySelector('.me-rich.shown .me-island[data-kind="forward"]')`, 10000).catch(() => {});
  await type('#mc-to', 'jo@park.example');
  await key('#mc-to', 'Enter');
  // A line typed into its HTML and sent at once with Ctrl+Enter (before the editor's pause) goes too.
  await click(await at('.me-island[data-kind="forward"] .me-island-btn', `el => el.textContent === 'Edit HTML'`));
  await page.until(`document.activeElement?.closest?.('.me-island-code') != null`, 15000).catch(() => {});
  await page.send('Input.insertText', { text: '<p>Typed just before sending</p>' });
  await press('Enter', 'Enter', 13, 2);
  await page.until(`/left out/.test(document.querySelector('.mc-strip')?.textContent ?? '')`, 10000).catch(() => {});
  const strip = await page.eval<string>(`document.querySelector('.mc-strip')?.textContent ?? ''`);
  check(`${tag}: the sending strip says how many pictures were left out`, /· 1 picture left out/.test(strip), strip);
  const end = Date.now() + 30_000;
  let sent: any = null;
  while (Date.now() < end && !sent) {
    await Bun.sleep(300);
    sent = (await threadNow(sale.id)).messages.find((m: any) => m.addressed === 'self' && m.subject.startsWith('Fwd:'));
  }
  check(`${tag}: the forward goes`, !!sent);
  if (!sent) return;
  const b = (await fetch(`${base}/api/mail/messages/${sent.id}/body`).then((r) => r.json())) as any;
  const doc = b.html ? await fetch(`${base}${b.html.url}`).then((r) => r.text()) : '';
  check(`${tag}: what was typed into its HTML just before Ctrl+Enter went`, doc.includes('Typed just before sending'));
  check(`${tag}: its pictures went inside the mail, as parts, none linked`, (doc.match(/\/cid\//g)?.length ?? 0) > 60 && !/<img[^>]+src="https?:/.test(doc) && (b.attachments ?? []).filter((a: any) => !a.inline).length === 0, { cid: doc.match(/\/cid\//g)?.length, files: b.attachments?.length });
}

// ------------------------------------------------------------------ summaries without headers (--proton)

const PROTON = 'acc_demo-proton';

/** The Proton-like account: its newsletter in Updates once its body came, never in Inbox; the stranger's note in Inbox. */
async function headerless(themeName: string, onPhone: boolean, first: boolean) {
  const tag = `${onPhone ? 'phone' : 'desktop'} ${themeName}: no headers on summaries`;
  const subjectsOf = async (list: string) => (await page1(list)).map((t) => t.subject as string);
  if (first) {
    if (!(await mailNow()).accounts?.some((a: any) => a.id === PROTON)) throw new Error('no Proton-like account: start the hub with DITHER_DEMO_MAIL_PROTON=1 for --proton');
    // Nothing on its summaries says it is a newsletter: only its body, fetched ahead (bodies.ts), does.
    let upd: string[] = [];
    for (let i = 0; i < 60 && !upd.some((s) => s.startsWith('Garden Club Weekly')); i++) {
      if (i) await Bun.sleep(500);
      upd = await subjectsOf(`v:updates:${PROTON}`);
    }
    const inbox = await subjectsOf(`v:inbox:${PROTON}`);
    check(`${tag}: the newsletter is in Updates once its body came`, upd.some((s) => s.startsWith('Garden Club Weekly')), upd);
    check(`${tag}: the receipt Proton sorted into Transactions is in Updates`, upd.includes('Your November statement is ready'), upd);
    check(`${tag}: Inbox keeps the stranger's note and neither of those`, inbox.includes('Found your scarf') && !inbox.some((s) => s.startsWith('Garden Club') || s.startsWith('Your November')), inbox);
  }
  if (onPhone) await page.size(390, 844, true);
  else await page.size(1400, 900);
  const rows = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.textContent)`);
  await theme(themeName, UPDATES);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.textContent.includes('Garden Club Weekly'))`, 15000);
  check(`${tag}: Updates shows the newsletter`, (await rows()).some((r) => r.includes('Garden Club Weekly')));
  check(`${tag}: no sideways overflow: Updates`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-proton-updates`);
  // The Inbox (its Mail filter) has the account's people but not its newsletter.
  await page.eval(`location.hash = '#/inbox'`);
  await page.until(`document.querySelectorAll('.sidebar .row[data-row]').length >= 3`, 15000);
  check(`${tag}: Inbox does not show the newsletter`, !(await page.eval<boolean>(`[...document.querySelectorAll('.sidebar .row[data-row]')].some((r) => r.textContent.includes('Garden Club Weekly'))`)));
  check(`${tag}: no sideways overflow: Inbox`, !(await overflow()).length, await overflow());

  // Two accounts: the wheels over a mail list pick whose mail it shows, and their menu says what the rows' dots are.
  await page.eval(`location.hash = ${JSON.stringify(inList('v:all:*'))}`);
  await page.until(`!!document.querySelector('.sidebar .scope-wheel') && [...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.textContent.includes('Found your scarf'))`, 15000);
  const press = onPhone ? tap : click;
  const bar = await chipRows();
  check(`${tag}: the mail lists are one row of chips`, bar.rows === 1, bar);
  // Two platforms (plain email and Proton): the wheel turns through All mail and each, a click at a time.
  const wheel = () => page.eval<string>(`[...document.querySelectorAll('.sidebar .scope-wheels .scope-wheel .scope-win .scope-row:not(.dim)')].map((r) => r.textContent).join(' › ')`);
  // All mail spans both accounts, so its account wheel shows too; a platform with one account needs none.
  check(`${tag}: the wheels say All mail, All accounts`, (await wheel()) === 'All mail › All accounts', await wheel());
  await press(await at('.sidebar .scope-wheel'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent('v:all:k.email'))})`, 5000).catch(() => {});
  check(`${tag}: a click turns it to the next platform`, (await wheel()) === 'Email', await wheel());
  await press(await at('.sidebar .scope-wheel'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent('v:all:k.proton'))})`, 5000);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.textContent.includes('Found your scarf'))`, 10000);
  check(`${tag}: and the next, whose mail only shows`, (await wheel()) === 'Proton' && !(await rows()).some((r) => r.includes('Dinner')), await wheel());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-one-account`);
  await press(await at('.sidebar .scope-wheel'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent('v:all:*'))})`, 5000).catch(() => {});
  check(`${tag}: and round to All mail`, (await wheel()) === 'All mail › All accounts', await wheel());

  // A right-click (a long press on a phone) opens the account menu, which says what the rows' dots are.
  await openMenuOn('.sidebar .scope-wheel');
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  const menu = await page.eval<{ text: string; dots: string[] }>(
    `(() => { const m = document.querySelector('.cm-sheet') ?? document.querySelector('.cm'); return { text: m.textContent, dots: [...m.querySelectorAll('.cm-dot')].map((d) => getComputedStyle(d).backgroundColor) }; })()`,
  );
  const rowDot = await page.eval<string>(`(() => { const d = [...document.querySelectorAll('.sidebar .mail-row .mail-acc-dot')].find((x) => x.title === 'zyan@proton.example'); return d ? getComputedStyle(d).backgroundColor : 'none'; })()`);
  check(
    `${tag}: its menu: All accounts, each account with its rows' dot, and what the dot is`,
    ['All accounts', 'zyan@dither.example', 'zyan@proton.example', 'a dot in the account'].every((x) => menu.text.includes(x)) && menu.dots.length === 3 && menu.dots.includes(rowDot),
    { ...menu, rowDot },
  );
  check(`${tag}: no sideways overflow: the account menu`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-account-menu`);
  await press(await menuItem('zyan@proton.example'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`v:all:${PROTON}`))})`, 5000);
  check(`${tag}: picking an account there shows its platform on the wheel`, (await wheel()) === 'Proton', await wheel());
  await openMenuOn('.sidebar .scope-wheel');
  await press(await menuItem('All accounts'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent('v:all:*'))})`, 5000).catch(() => {});
  check(`${tag}: and All accounts again`, (await wheel()) === 'All mail › All accounts', await wheel());
}

// ------------------------------------------------------------------ a Gmail account (--gmail)

const GMAIL_ACC = 'acc_demo-gmail';
const GMAIL_ME = 'zyan@gmail.example';

/** The Gmail account: in the account menu, its labels as mailboxes, its threads once each, archive and trash. */
async function gmail(themeName: string, onPhone: boolean, step: 'archive' | 'trash' | null) {
  const tag = `${onPhone ? 'phone' : 'desktop'} ${themeName}: Gmail`;
  const sz = onPhone ? 'phone' : 'desktop';
  const press = onPhone ? tap : click;
  const now = await mailNow();
  if (!now.accounts?.some((a: any) => a.id === GMAIL_ACC)) throw new Error('no Gmail account: start the hub with DITHER_DEMO_MAIL_GMAIL=1 for --gmail');
  const boxes = now.mailboxes.filter((b: any) => b.accountId === GMAIL_ACC);
  const boxOf = (path: string) => boxes.find((b: any) => b.path === path)!;
  const all = boxOf('[Gmail]/All Mail');
  const travel = boxOf('Travel');
  const family = boxOf('Family');
  const hubThread = async (id: string) => ((await fetch(`${base}/api/mail/threads/${id}`).then((r) => r.json())) as { thread: any }).thread;
  const settled = async (id: string, f: (t: any) => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await hubThread(id);
      if (!t.pending && f(t)) return true;
      if (Date.now() > end) return false;
      await Bun.sleep(150);
    }
  };
  const once = (ts: any[]) => new Set(ts.map((t) => t.id)).size === ts.length;
  const lists = { inbox: await page1(`v:inbox:${GMAIL_ACC}`), all: await page1(`mb:${all.id}`), travel: await page1(`mb:${travel.id}`), family: await page1(`mb:${family.id}`) };
  const find = (s: string) => [...lists.inbox, ...lists.all].find((t) => t.subject.includes(s));
  const coast = find('Trip to the coast');
  check(`${tag}: one row a thread in Inbox, All Mail and each label`, Object.values(lists).every(once) && lists.all.filter((t) => t.id === coast?.id).length === 1, Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.map((t) => t.subject)])));
  check(`${tag}: a thread's labels are its own, none of Gmail's`, coast?.labels.join() === 'Travel' && lists.all.every((t) => t.labels.every((l: string) => !l.startsWith('\\'))), coast?.labels);
  check(`${tag}: All Mail is the archive (no Archive mailbox), [Gmail] has no counts`, all.role === 'all' && !boxes.some((b: any) => b.role === 'archive') && boxOf('[Gmail]').total === null);

  if (onPhone) await page.size(390, 844, true);
  else await page.size(1400, 900);
  await theme(themeName, inList('v:all:*'));
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 3`, 15000);
  const rows = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.dataset.thread)`);
  /** A thread's chat over its list, as a row opens it (the list keeps its Undo). */
  const open = async (id: string, list: string) => {
    await page.eval(`location.hash = ${JSON.stringify(inList(list, id))}`);
    await page.until(`!!document.querySelector('.mail-thread-pane .mail-thread-head .hdr-btn') || !!document.querySelector('${PANE} [id^="m-mml_"]')`, 15000);
  };
  /**
   * A thread filed from its chat: by the header's buttons where it is a chat of its own (Trash in its ⋯); in a
   * person's chat, by its subject tag's card (Archive, Unarchive) or a mail's menu (the trash).
   */
  const fileIt = async (id: string, what: 'Archive' | 'Move to Inbox' | 'Move to the trash') => {
    if (await has('.mail-thread-pane')) {
      const btn = (label: string) => `.mail-thread-head .hdr-btn[aria-label="${label}"]`;
      await page.until(`!!document.querySelector(${JSON.stringify(btn(what === 'Move to the trash' ? 'More' : what))})`, 15000);
      if (what !== 'Move to the trash') return press(await at(btn(what)));
      await press(await at(btn('More')));
      await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
      return press(await menuItem('Move to the trash'));
    }
    const card = msg((await mailsOf(id))[0].id);
    await page.until(`!!document.querySelector(${JSON.stringify(`${card} .mail-tag`)})`, 15000);
    if (what === 'Move to the trash') {
      await at(`${card} .msg-body`);
      if (onPhone) await hold(await page.eval<Pt>(`(() => { const b = document.querySelector(${JSON.stringify(`${card} .msg-body`)}).getBoundingClientRect(); return [Math.round(b.x + 16), Math.round(b.y + 10)]; })()`));
      else await openMenuOn(`${card} .msg-body`);
      await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
      return press(await menuItem('Move the thread to the trash'));
    }
    await press(await at(`${card} .mail-tag`));
    await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
    await press(await menuItem(what === 'Archive' ? 'Archive' : 'Unarchive'));
  };
  /** What says it was filed, with its Undo: the list's line, or a toast where the chat's own card filed it. */
  const undoLine = () => page.eval<string>(`[...document.querySelectorAll('.mail-undo, .toast')].map((e) => e.textContent).join(' | ')`);
  const undo = async () => press(await at('.mail-undo .link-btn, .toast', `el => el.textContent.includes('Undo')`));

  // The account menu, on the wheel over a mail list.
  await openMenuOn('.sidebar .scope-wheel');
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  const accMenu = await page.eval<string>(`(document.querySelector('.cm-sheet') ?? document.querySelector('.cm')).textContent`);
  check(`${tag}: the account menu has the Gmail account`, accMenu.includes(GMAIL_ME) && accMenu.includes('All accounts'), accMenu);
  await press(await menuItem(GMAIL_ME));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`v:all:${GMAIL_ACC}`))})`, 5000);
  // Its Inbox as a list: the account's view (the Inbox chip is every account's, chats and all).
  await page.eval(`location.hash = ${JSON.stringify(inList(`v:inbox:${GMAIL_ACC}`))}`);
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 2`, 10000);
  const inboxRows = await rows();
  check(`${tag}: its Inbox, each thread once`, inboxRows.includes(coast.id) && new Set(inboxRows).size === inboxRows.length, inboxRows.length);
  check(`${tag}: no sideways overflow: its Inbox`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-inbox`);

  // More's menu: Inbox, the labels, Gmail's own; not `[Gmail]`, which only holds them.
  await press(await at('.sidebar .mail-more-chip'));
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  const items = await page.eval<string[]>(`[...(document.querySelector('.cm-sheet') ?? document.querySelector('.cm')).querySelectorAll('.cm-item, button')].map((b) => b.textContent.trim()).filter(Boolean)`);
  check(`${tag}: More's menu has its labels and Gmail's mailboxes`, ['Travel', 'Family', '[Gmail] / All Mail', '[Gmail] / Spam', '[Gmail] / Trash'].every((x) => items.includes(x)), items);
  check(`${tag}: and not [Gmail], which only holds mailboxes`, !items.includes('[Gmail]'), items);
  check(`${tag}: no sideways overflow: More's menu`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-mailboxes`);
  await press(await menuItem('Travel'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`mb:${travel.id}`))})`, 5000);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.dataset.thread === ${JSON.stringify(coast.id)})`, 10000);
  const travelRows = await rows();
  check(`${tag}: a label lists its threads, each once`, travelRows.includes(coast.id) && new Set(travelRows).size === travelRows.length, travelRows.length);
  check(`${tag}: More is lit with the label's name`, (await page.eval<string>(`document.querySelector('.sidebar .mail-more-chip.on')?.textContent ?? ''`)).includes('Travel'));
  check(`${tag}: no sideways overflow: a label`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-label`);

  // The reader showed the thread's labels; a chat shows no labels (dropped). The row opens the thread's chat, and no
  // Gmail system label shows anywhere on it.
  await press(await at(`.sidebar .mail-row[data-thread="${coast.id}"]`));
  await page.until(`!!document.querySelector('${PANE} [id^="m-mml_"]')`, 15000);
  const chatText = await page.eval<string>(`document.querySelector('${PANE}').textContent`);
  check(`${tag}: the thread's chat shows no \\Inbox or \\Important`, !/\\(Inbox|Important|Sent|Starred)/.test(chatText));
  check(`${tag}: no sideways overflow: its chat`, !(await overflowThrough(`${PANE} .timeline-scroll`)).length, await overflowThrough(`${PANE} .timeline-scroll`));
  await shot(`mail-${sz}-${themeName}-gmail-chat`);

  if (step === 'archive') {
    // Garden photos, from Family: Archive, Undo before it reaches Gmail, then Archive for good.
    const photos = find('Garden photos');
    await open(photos.id, `v:inbox:${GMAIL_ACC}`);
    await fileIt(photos.id, 'Archive');
    await page.until(`/Archived/.test([...document.querySelectorAll('.mail-undo, .toast')].map((e) => e.textContent).join())`, 5000).catch(() => {});
    check(`${tag}: Archive says "Archived · Undo"`, /Archived/.test(await undoLine()) && /Undo/.test(await undoLine()), await undoLine());
    await undo();
    check(`${tag}: Undo brings it back before Gmail heard of it`, await settled(photos.id, (t) => t.roles.includes('inbox')));
    await open(photos.id, `v:inbox:${GMAIL_ACC}`);
    await page.eval(`document.querySelectorAll('.toasts .toast-x').forEach((x) => x.click())`);
    await fileIt(photos.id, 'Archive');
    check(`${tag}: Archive for good: out of Inbox, in All Mail`, await settled(photos.id, (t) => !t.roles.includes('inbox') && t.roles.includes('all')));
    const [inAll, inFamily, inbox] = [await page1(`mb:${all.id}`), await page1(`mb:${family.id}`), await page1(`v:inbox:${GMAIL_ACC}`)];
    check(`${tag}: once in All Mail, still in Family, not in Inbox`, inAll.filter((t) => t.id === photos.id).length === 1 && inFamily.some((t) => t.id === photos.id) && !inbox.some((t) => t.id === photos.id));
    await shot(`mail-${sz}-${themeName}-gmail-archived`);

    // Move to Inbox from All Mail: the extractor copies it there (a move out of All Mail would delete it on Gmail).
    const before = await hubThread(photos.id);
    await open(photos.id, `mb:${all.id}`);
    await page.eval(`document.querySelectorAll('.toasts .toast-x').forEach((x) => x.click())`);
    await fileIt(photos.id, 'Move to Inbox');
    await page.until(`/Moved to Inbox/.test([...document.querySelectorAll('.mail-undo, .toast')].map((e) => e.textContent).join())`, 5000).catch(() => {});
    check(`${tag}: Move to Inbox says "Moved to Inbox · Undo"`, /Moved to Inbox/.test(await undoLine()) && /Undo/.test(await undoLine()), await undoLine());
    check(`${tag}: Move to Inbox from All Mail: in Inbox and All Mail`, await settled(photos.id, (t) => t.roles.includes('inbox') && t.roles.includes('all')));
    const back = await hubThread(photos.id);
    const [inAll2, inFamily2, inbox2] = [await page1(`mb:${all.id}`), await page1(`mb:${family.id}`), await page1(`v:inbox:${GMAIL_ACC}`)];
    const named = (ts: any[]) => ts.filter((t) => t.subject === photos.subject).length;
    check(
      `${tag}: back in Inbox once, still once in All Mail and in Family, one message`,
      named(inbox2) === 1 && inbox2.some((t) => t.id === photos.id) && named(inAll2) === 1 && inFamily2.some((t) => t.id === photos.id) && back.count === before.count && back.labels.join() === 'Family',
      { inbox: named(inbox2), all: named(inAll2), count: [before.count, back.count], labels: back.labels },
    );
    await page.eval(`location.hash = ${JSON.stringify(inList(`v:inbox:${GMAIL_ACC}`))}`);
    await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.dataset.thread === ${JSON.stringify(photos.id)})`, 10000).catch(() => {});
    const inboxRows2 = await rows();
    check(`${tag}: its row is in the Inbox list once`, inboxRows2.filter((id) => id === photos.id).length === 1, inboxRows2.length);
    await shot(`mail-${sz}-${themeName}-gmail-back-in-inbox`);
  }
  if (step === 'trash') {
    // The booking, archived under Travel: to the trash, out of All Mail and Travel. Trash is in the header's ⋯.
    const hotel = find('Your booking is confirmed');
    await open(hotel.id, `mb:${travel.id}`);
    await fileIt(hotel.id, 'Move to the trash');
    check(`${tag}: Move to the trash: in Trash alone`, await settled(hotel.id, (t) => t.roles.join() === 'trash'));
    const [inAll, inTravel] = [await page1(`mb:${all.id}`), await page1(`mb:${travel.id}`)];
    check(`${tag}: out of All Mail and Travel`, !inAll.some((t) => t.id === hotel.id) && !inTravel.some((t) => t.id === hotel.id));
    check(`${tag}: no sideways overflow: after the trash`, !(await overflow()).length, await overflow());
    await shot(`mail-${sz}-${themeName}-gmail-trashed`);
  }
}

// ------------------------------------------------------------------ from a person (slice 8)

const UPDATES = inList('v:updates:*');

/**
 * With the Mail filter, the Inbox has people's mail and leaves newsletters and notifications to Updates, a chip over
 * the list; Everything has both; a thread's menu says "Not a person" (to Updates) or "This is a person" (back), on
 * Theo's thread, which no other run uses.
 */
async function classification(themeName: string, onPhone: boolean) {
  const tag = `${onPhone ? 'phone' : 'desktop'} ${themeName}: from a person`;
  const go = onPhone ? tap : click;
  if (onPhone) await page.size(390, 844, true);
  else await page.size(1400, 900);
  await theme(themeName, '#/inbox');
  await page.until(`!!document.querySelector('.sidebar .mail-list-chips') && document.querySelectorAll('.sidebar .row[data-row]').length >= 3`, 15000);
  const shownIds = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.dataset.thread)`);
  const bulk = new Set(updateThreads.map((t) => t.id));
  check(`${tag}: Inbox shows no newsletters or notifications`, !(await inboxRows()).some((id) => bulk.has(id)), await inboxRows());
  // The Inbox's one Updates row is gone: Updates is a chip over the list, always there.
  check(`${tag}: no sideways overflow: Inbox with Mail on`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-inbox-mail`);
  await go(await at('.sidebar .mail-list-chips .chip-btn', `el => el.textContent === 'Updates'`));
  await page.until(`location.hash.includes('v%3Aupdates')`, 5000);
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 5`, 10000);
  const upd = await shownIds();
  check(`${tag}: Updates: the mail not from a person`, upd.length >= 5 && upd.every((id) => bulk.has(id)), upd.length);
  check(`${tag}: Updates has its chip lit while you are in it`, (await page.eval<string>(`document.querySelector('.sidebar .mail-list-chips .chip-btn.on')?.textContent ?? ''`)) === 'Updates');
  check(`${tag}: no sideways overflow: Updates`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-updates`);
  // Ranked and Newest are gone with the Mail page's Inbox: the Inbox ranks mail with the chats (docs/inbox.md).
  // Everything: all of it, the newsletters too.
  await go(await at('.sidebar .mail-list-chips .chip-btn', `el => el.textContent === 'Everything'`));
  await page.until(`location.hash.includes('v%3Aall')`, 5000);
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 8`, 10000);
  const all = await shownIds();
  check(`${tag}: Everything: Dinner, the lease and the newsletters`, all.includes(dinner.id) && all.includes(lease.id) && all.some((id) => bulk.has(id)), all.length);
  check(`${tag}: no sideways overflow: Everything`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-everything`);
  // People has no chip; an old link to the Mail page's People still lists.
  await page.eval(`location.hash = ${JSON.stringify(`#/mail/l/${encodeURIComponent('v:people:*')}`)}`);
  await page.until(`location.hash.includes('v%3Apeople')`, 5000);
  await Bun.sleep(600);
  const ppl = await shownIds();
  // Read as the Inbox's list (routes.ts), the address kept as typed.
  check(`${tag}: an old People link: in the Inbox's place, Dinner and the lease, no newsletters`, (await has('.sidebar .mail-list-chips')) && ppl.includes(dinner.id) && ppl.includes(lease.id) && !ppl.some((id) => bulk.has(id)), { hash: await hash(), n: ppl.length });
  if (onPhone) return;
  // Theo's climbing mail: nobody knows him (rule 11). Not a person, then a person after all.
  const climb = byTitle('Climbing on Sunday');
  const sel = `.sidebar .mail-row[data-thread="${climb.id}"]`;
  const menu = async () => {
    const [x, y] = await at(sel);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'right', buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1 });
    await Bun.sleep(300);
    return page.eval<string>(`document.querySelector('.cm')?.textContent ?? ''`);
  };
  const pick = async (label: string) => {
    await click(await at('.cm .cm-item', `el => el.textContent.includes(${JSON.stringify(label)})`));
    await Bun.sleep(600);
  };
  const classOf = async () => ((await fetch(`${base}/api/mail/threads/${climb.id}`).then((r) => r.json())) as any).thread;
  check(`${tag}: a sender nobody knows is in People, marked unknown`, (await shownIds()).includes(climb.id) && (await classOf()).unknown === true);
  const m = await menu();
  check(`${tag}: its menu offers both`, m.includes('This is a person') && m.includes('Not a person'), m);
  await pick('Not a person');
  check(`${tag}: "Not a person" sends it to Updates`, (await classOf()).class === 'bulk' && !(await has(sel)));
  await page.eval(`location.hash = ${JSON.stringify(UPDATES)}`);
  await page.until(`!!document.querySelector(${JSON.stringify(sel)})`, 5000);
  check(`${tag}: and it is in Updates`, await has(sel));
  check(`${tag}: there its menu says "This is a person"`, (await menu()).includes('This is a person'));
  await pick('This is a person');
  const back = await classOf();
  check(`${tag}: "This is a person" brings it back, no longer unknown`, back.class === 'personal' && back.unknown === false, back);
  // As it was, for the next run.
  await fetch(`${base}/api/mail/threads/${climb.id}/person`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ person: null }) });
}

// ------------------------------------------------------------------ filing (slice 4)

/** Slice 4 on the library's weekly digests (read, in Inbox's Updates), a pair per run, so the runs do not meet. */
async function filing() {
  const hubThread = async (id: string) => (await fetch(`${base}/api/mail/threads/${id}`).then((r) => r.json())) as { thread: any; messages: any[] };
  const settled = (id: string, f: (t: any) => boolean, what: string) =>
    (async () => {
      const end = Date.now() + 8000;
      for (;;) {
        const t = (await hubThread(id)).thread;
        if (!t.pending && f(t)) return true;
        if (Date.now() > end) throw new Error(`the hub never had ${what}: ${JSON.stringify({ roles: t.roles, unread: t.unread, flagged: t.flagged, pending: t.pending })}`);
        await Bun.sleep(100);
      }
    })();
  const week = (n: number) => threads.find((t) => t.subject === `New arrivals, week ${n}`)!;
  const row = (id: string) => `.sidebar .mail-row[data-thread="${id}"]`;
  const box = async (sel: string) => {
    await at(sel);
    return page.eval<{ l: number; r: number; y: number }>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: b.left, r: b.right, y: b.top + b.height / 2 }; })()`);
  };
  async function swipe(sel: string, dir: 1 | -1) {
    const b = await box(sel);
    const x0 = dir > 0 ? b.l + 30 : b.r - 30;
    await touch('touchStart', [[x0, b.y]]);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [[x0 + dir * i * 22, b.y + i * 0.5]]);
      await Bun.sleep(16);
    }
    await touch('touchEnd', []);
    await Bun.sleep(600);
  }
  async function longPress(sel: string) {
    const p = await at(sel);
    await touch('touchStart', [p]);
    await Bun.sleep(650);
    await touch('touchEnd', []);
    await Bun.sleep(300);
  }
  async function mouse(p: Pt, button: 'left' | 'right', modifiers = 0) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await page.send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], modifiers, button: type === 'mouseMoved' ? 'none' : button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
    await Bun.sleep(300);
  }
  const key = (k: string) => page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);

  // Read in view (the phone run opened Dinner for a second): the server has it read, not only the hub.
  const dinnerNow = await hubThread(dinner.id);
  check('filing: read in view reaches the server', dinnerNow.messages.every((m) => m.flags.seen), dinnerNow.messages.map((m) => m.flags));

  for (const [themeName, n] of [['dither-dark', 40], ['dither-light', 38]] as const) {
    const tag = `phone ${themeName}: filing`;
    const a = week(n);
    const b = week(n - 1);
    await page.size(390, 844, true);
    await theme(themeName, UPDATES);
    await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 15000);
    await swipe(row(a.id), 1);
    await page.until(`!document.querySelector(${JSON.stringify(row(a.id))})`, 5000).catch(() => {});
    check(`${tag}: a swipe right archives the row away`, !(await has(row(a.id))));
    const undoLine = await page.eval<string>(`document.querySelector('.mail-undo')?.textContent ?? ''`);
    check(`${tag}: "Archived · Undo" shows`, undoLine.includes('Archived'), { undoLine, strips: await page.eval<string>(`[...document.querySelectorAll('.mc-strip, .mail-ops-note')].map((e) => e.textContent).join(' | ')`) });
    check(`${tag}: the hub archived it on the server`, await settled(a.id, (t) => t.roles.includes('archive') && !t.roles.includes('inbox'), 'it archived'));
    check(`${tag}: no sideways overflow: Undo`, !(await overflow()).length, await overflow());
    await shot(`mail-phone-${themeName}-archived`);
    await tap(await at('.mail-undo .link-btn'));
    await page.until(`!!document.querySelector(${JSON.stringify(row(a.id))})`, 5000).catch(() => {});
    check(`${tag}: Undo brings it back`, (await has(row(a.id))) && (await settled(a.id, (t) => t.roles.includes('inbox'), 'it back in Inbox')));

    await swipe(row(b.id), -1);
    check(`${tag}: a swipe left marks it unread`, (await has(`${row(b.id)}.unread`)) && (await settled(b.id, (t) => t.unread === 1, 'it unread')));
    await swipe(row(b.id), -1);
    check(`${tag}: and again marks it read`, !(await has(`${row(b.id)}.unread`)) && (await settled(b.id, (t) => t.unread === 0, 'it read')));

    await longPress(row(a.id));
    const picked = () => page.eval<string[]>(`[...document.querySelectorAll('.mail-swipe.selected .mail-row')].map((r) => r.dataset.thread)`);
    check(`${tag}: a long press picks that thread`, (await page.eval<string>(`document.querySelector('.mail-pickbar-n')?.textContent ?? ''`)) === '1' && (await picked()).join() === a.id, await picked());
    await tap(await at(row(b.id)));
    check(`${tag}: then a tap picks another, and does not open it`, (await picked()).sort().join() === [a.id, b.id].sort().join() && !(await hash()).includes('/c/'), await picked());
    check(`${tag}: no sideways overflow: the selection's bar`, !(await overflow()).length, await overflow());
    await shot(`mail-phone-${themeName}-picked`);
    await tap(await at('.mail-pickbar .icon-btn[aria-label="Star"]'));
    check(`${tag}: the bar stars both`, (await settled(a.id, (t) => t.flagged, 'a starred')) && (await settled(b.id, (t) => t.flagged, 'b starred')) && !(await has('.mail-pickbar')));
    await fetch(`${base}/api/mail/flag`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ threadIds: [a.id, b.id], flagged: false }) });
  }

  for (const [themeName, n] of [['dither-dark', 36], ['dither-light', 34]] as const) {
    const tag = `desktop ${themeName}: filing`;
    const c = week(n);
    const d = week(n - 1);
    await page.size(1400, 900);
    await theme(themeName, UPDATES);
    await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 15000);
    await click(await at(row(c.id)));
    await page.until(`!!document.querySelector('.mail-thread-pane .mail-thread-head .hdr-btn')`, 15000);
    // The reader's header had Trash beside Archive; a thread's chat has it in ⋯, as a chat's header keeps one row.
    check(`${tag}: the thread's header has Archive, Star and ⋯`, (await headButtons()).join() === 'Archive,Star,More', await headButtons());
    await click(await at('.mail-thread-head .hdr-btn[aria-label="More"]'));
    await page.until(`!!document.querySelector('.cm')`, 5000);
    check(`${tag}: ⋯ has Move to the trash`, (await page.eval<string>(`document.querySelector('.cm').textContent`)).includes('Move to the trash'));
    await page.eval(`document.querySelector('.cm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await page.until(`!document.querySelector('.cm')`, 5000).catch(() => {});
    await click(await at('.mail-thread-head .hdr-btn[aria-label="Star"]'));
    check(`${tag}: Star stars it`, (await page.until(`!!document.querySelector('.mail-thread-head .hdr-btn[aria-label="Unstar"]')`, 5000).then(() => true, () => false)) && (await settled(c.id, (t) => t.flagged, 'it starred')));
    await click(await at('.mail-thread-head .hdr-btn[aria-label="Unstar"]'));
    check(`${tag}: Unstar unstars it`, await settled(c.id, (t) => !t.flagged, 'it unstarred'));
    await shot(`mail-desktop-${themeName}-thread`);
    await page.eval('document.activeElement?.blur?.()');
    await key('e');
    await Bun.sleep(400);
    check(`${tag}: e archives the open thread and goes back to the list`, !(await hash()).includes('/c/') && !(await has(row(c.id))) && (await settled(c.id, (t) => !t.roles.includes('inbox'), 'it archived')));
    await click(await at('.mail-undo .link-btn'));
    check(`${tag}: Undo brings it back`, await settled(c.id, (t) => t.roles.includes('inbox'), 'it back'));
    await page.until(`!!document.querySelector(${JSON.stringify(row(c.id))})`, 5000).catch(() => {});

    await mouse(await at(row(d.id)), 'right');
    const menu = await page.eval<string>(`document.querySelector('.cm')?.textContent ?? ''`);
    check(`${tag}: a row's right-click menu files it`, ['Archive', 'Move to…', 'Mark as junk', 'Move to the trash', 'Select'].every((l) => menu.includes(l)), menu);
    await page.eval(`document.querySelector('.cm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await Bun.sleep(200);
    await mouse(await at(row(c.id)), 'left', 2);
    await mouse(await at(row(d.id)), 'left', 2);
    check(`${tag}: Ctrl-click picks threads`, (await page.eval<string>(`document.querySelector('.mail-pickbar-n')?.textContent ?? ''`)) === '2');
    check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
    await key('Escape');
    await Bun.sleep(200);
    check(`${tag}: Escape lets them go`, !(await has('.mail-pickbar')));
  }

  await page.goto(`${base}/#/settings`);
  await page.until(`!!document.querySelector('#set-mail .mail-read-set')`, 10000).catch(() => {});
  check('filing: Settings → Mail has the read setting', (await page.eval<string>(`document.querySelector('#set-mail .mail-read-set')?.textContent ?? ''`)).includes('Only when I mark it'));
}

// ------------------------------------------------------------------ slice 3: the HTML frame (--html)

const FRAME = '.chat-mail-sent .mail-html.ready iframe.mail-frame';
/** The open mail's frame document, as an expression. */
const FD = `[...document.querySelectorAll(${JSON.stringify(FRAME)})].pop().contentDocument`;

/** An element in the open mail's frame, scrolled into view, as a point on the page. */
async function inFrame(sel: string): Promise<Pt> {
  const r = await page.eval(`(() => {
    const f = [...document.querySelectorAll(${JSON.stringify(FRAME)})].pop();
    const el = f?.contentDocument?.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const a = f.getBoundingClientRect(), b = el.getBoundingClientRect();
    return [Math.round(a.left + b.left + Math.min(b.width / 2, 24)), Math.round(a.top + b.top + b.height / 2)];
  })()`);
  if (!r) throw new Error(`nothing in the frame matches ${sel}`);
  await Bun.sleep(200);
  return r;
}
async function swipe(a: Pt, b: Pt, steps = 14) {
  await touch('touchStart', [a]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]]);
    await Bun.sleep(16);
  }
  await touch('touchEnd', []);
  await Bun.sleep(600);
}
/** The menu item (desktop) or sheet button (phone) with this text. */
const menuItem = (text: string) => at('.cm-item, .cm-sheet button', `el => el.textContent.includes(${JSON.stringify(text)})`);

/** A mail in a chat as it was sent: its ···, then "Show as sent", and its frame drawn. */
async function asSent(card: string, press: (p: Pt) => Promise<void>) {
  await page.until(`!!document.querySelector(${JSON.stringify(`${card} .mail-quote-dots`)})`, 15000);
  await press(await at(`${card} .mail-quote-dots`));
  await press(await at(`${card} .mail-open-chip`, `el => el.textContent.includes('Show as sent')`));
  await page.until(`!!document.querySelector(${JSON.stringify(`${card} ${FRAME}`)})?.contentDocument?.querySelector('.dc-mail')`, 15000);
}

async function htmlChecks() {
  const autumn = byTitle('Autumn at the library');
  if (!autumn) throw new Error('the demo has no HTML mail (hub demo-html.ts)');
  const autumnCard = msg((await mailsOf(autumn.id))[0].id);
  const [plan] = (await mailsOf(garden.id)).filter((m) => m.addressed !== 'self');
  const planCard = msg(plan.id);
  // Every request the page makes from here on, and those the CSP stopped before they went.
  const asked = new Map<string, string>();
  const stopped = new Set<string>();
  page.on('Network.requestWillBeSent', (p) => asked.set(p.requestId, p.request.url));
  page.on('Network.loadingFailed', (p) => p.blockedReason && stopped.add(p.requestId));
  const opened = () => page.eval<[string, string, string][]>('window.__opened');
  const stubOpen = () => page.eval(`(() => { window.__opened = []; window.open = (u, t, f) => (window.__opened.push([String(u), t, f]), null); })()`);

  for (const themeName of ['dither-dark', 'dither-light']) {
    const tag = `html phone ${themeName}`;
    const first = themeName === 'dither-dark';
    await page.size(390, 844, true);
    await theme(themeName, inList('v:updates:*', autumn.id));
    await asSent(autumnCard, tap);
    await Bun.sleep(500);
    await stubOpen();

    const frame = await page.eval<{ sandbox: string; referrer: string; sheet: string; body: string }>(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); return { sandbox: f.getAttribute('sandbox'), referrer: f.getAttribute('referrerpolicy'), sheet: getComputedStyle(f.parentElement).backgroundColor, body: getComputedStyle(f.contentDocument.body).backgroundColor }; })()`);
    check(`${tag}: the frame is sandboxed without scripts`, frame.sandbox === 'allow-same-origin' && frame.referrer === 'no-referrer', frame);
    check(`${tag}: a white sheet`, frame.sheet === 'rgb(255, 255, 255)' && frame.body === 'rgb(255, 255, 255)', frame);
    const left = await page.eval<string[]>(`(() => { const d = ${FD}, bad = []; for (const el of d.body.querySelectorAll('*')) { if (/^(script|iframe|object|embed|form|input|button|svg|math|meta|base|link|template|noscript)$/i.test(el.tagName)) bad.push(el.tagName); for (const a of el.attributes) if (/^on/i.test(a.name) || /^\\s*javascript:/i.test(a.value)) bad.push(el.tagName + ' ' + a.name); } return bad; })()`);
    check(`${tag}: nothing that runs is left in the mail`, !left.length, left);
    check(`${tag}: none of its script ran`, !(await page.eval<boolean>(`document.title.includes('hacked')`)));
    if (first) {
      // Put there by hand, script still does not run: the frame's sandbox stops it. An image from elsewhere does not load: the CSP stops it.
      const errorsBefore = page.errors.length;
      await page.eval(`(() => { const d = ${FD}; window.__ran = 0;
        const s = d.createElement('script'); s.textContent = 'parent.__ran = 1'; d.body.append(s);
        const i = d.createElement('img'); i.setAttribute('onerror', 'parent.__ran = 2'); i.src = 'data:,x'; i.className = 'probe'; d.body.append(i);
        const im = d.createElement('img'); im.src = 'https://evil.example/canary.png'; im.className = 'probe'; d.body.append(im);
        const st = d.createElement('div'); st.className = 'probe'; st.style.backgroundImage = 'url(https://evil.example/css-canary.png)'; st.style.height = '4px'; d.body.append(st); })()`);
      await Bun.sleep(700);
      check(`${tag}: script put in the frame by hand does not run`, (await page.eval<number>('window.__ran')) === 0);
      await page.eval(`${FD}.querySelectorAll('.probe, script').forEach((x) => x.remove())`);
      // The browser says it blocked them; that is the point, not an error.
      page.errors.splice(errorsBefore, page.errors.length - errorsBefore, ...page.errors.slice(errorsBefore).filter((e) => !/sandbox|allow-scripts|Content Security Policy|canary/i.test(e)));
    }

    // Fit to the width: the 600 px newsletter is scaled down, nothing runs off the side.
    const fit = await page.eval<{ frame: number; mail: number; transform: string; height: number }>(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); const m = f.contentDocument.querySelector('.dc-mail'); return { frame: f.clientWidth, mail: Math.round(m.getBoundingClientRect().width), transform: m.style.transform, height: f.clientHeight }; })()`);
    check(`${tag}: a wide mail is scaled to the width`, fit.transform.includes('scale(') && fit.mail <= fit.frame + 1 && fit.height > 200, fit);
    check(`${tag}: no sideways overflow: a mail as sent`, !(await overflowThrough(`${PANE} .timeline-scroll`)).length, await overflowThrough(`${PANE} .timeline-scroll`));

    // The picture bar (docs/mail.md "Pictures and trackers"): those unlikely to tell load through the hub, the one that
    // would tell is held back, the tracker removed; Load all loads it, through the hub too.
    if (first) {
      const banner = await page.eval<string>(`document.querySelector('.mail-img-banner')?.textContent ?? ''`);
      check(`${tag}: a picture that would tell held back, a tracker removed, with a bar saying so`, /\d+ pictures? loaded/.test(banner) && /\d+ held back/.test(banner) && banner.includes('tracker removed'), banner);
      check(`${tag}: a placeholder where it was`, (await page.eval<number>(`${FD}.querySelectorAll('.dc-img-blocked').length`)) >= 1);
      await shot('mail-html-phone-blocked');
      await tap(await at('.mail-img-banner .link-btn', `el => el.textContent.trim() === 'Load all'`));
      await page.until(`(() => { const d = ${FD}; const im = [...(d?.querySelectorAll('img') ?? [])].filter((i) => i.getAttribute('src')?.startsWith('/api/mail/img/')); return im.length >= 2 && im.every((i) => i.complete && i.naturalWidth > 0) && !d.querySelector('.dc-img-blocked'); })()`, 15000);
      check(`${tag}: Load all shows them, through the hub`, !/held back/.test(await page.eval<string>(`document.querySelector('.mail-img-banner')?.textContent ?? ''`)));
      await stubOpen();
    }
    await shot(`mail-html-${tag.replace(/ /g, '-')}`);

    // A link: through the app's opener; the frame stays where it is.
    const url = await page.eval<string>(`${FD}.URL`);
    await tap(await inFrame('a[href="https://library.example/events"]'));
    check(`${tag}: a link opens through the app's opener`, JSON.stringify(await opened()) === JSON.stringify([['https://library.example/events', '_blank', 'noopener,noreferrer']]), await opened());
    check(`${tag}: and the frame does not follow it`, (await page.eval<string>(`${FD}.URL`)) === url);
    // One whose text names another site: asked first, showing where it really goes.
    await tap(await inFrame('a[href="https://library-events.example/rsvp"]'));
    await page.until(`!!document.querySelector('.cm-sheet .mail-link-ask')`, 5000);
    check(`${tag}: a link whose text names another site asks first`, (await page.eval<string>(`document.querySelector('.mail-link-ask').textContent`)).includes('library-events.example') && (await opened()).length === 1);
    await tap(await menuItem('Open library-events.example'));
    check(`${tag}: and opens once you say so`, (await opened())[1]?.[0] === 'https://library-events.example/rsvp', await opened());

    // Swipe back over the body.
    const fr = await page.eval<{ left: number; top: number; bottom: number }>(`(() => { const f = document.querySelector(${JSON.stringify(FRAME)}); f.scrollIntoView({ block: 'start' }); const r = f.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: Math.min(r.bottom, innerHeight) }; })()`);
    await Bun.sleep(300);
    const y = Math.round((Math.max(fr.top, 80) + fr.bottom) / 2);
    await swipe([Math.round(fr.left + 24), y], [370, y + 4]);
    check(`${tag}: swiping back over the body goes back`, !(await hash()).includes('/c/') && (await inView('.sidebar .mail-row')), await hash());

    // The files under the mail's words (no need to open it), then as sent: its quote folded, a cid: picture.
    await page.eval(`location.hash = ${JSON.stringify(`#/inbox/c/${encodeURIComponent(aliceRoute.id)}?m=${plan.id}`)}`);
    await page.until(`document.querySelectorAll(${JSON.stringify(`${planCard} .mail-files .att-file`)}).length >= 2`, 15000);
    const cards = await page.eval<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${planCard} .mail-files .att-file b`)})].map((b) => b.textContent)`);
    check(`${tag}: the files, but not the picture the mail shows itself`, cards.join() === 'seeds.txt,garden-plan.pdf', cards);
    if (first) {
      await tap(await at(`${planCard} .mail-files .att-file`, `el => el.textContent.includes('seeds.txt')`));
      await page.until(`(document.querySelector('.fviewer')?.textContent ?? '').includes('San Marzano')`, 10000);
      check(`${tag}: a text file opens in the viewer`, true);
      await tap(await at('.fviewer .icon-btn[aria-label="Close"]'));
      await tap(await at(`${planCard} .mail-files .att-file`, `el => el.textContent.includes('garden-plan.pdf')`));
      await page.until(`!!document.querySelector('.fviewer[data-kind="pdf"] .fv-page canvas, .fviewer[data-kind="pdf"] .fv-page')`, 20000);
      check(`${tag}: a PDF opens in the viewer`, await page.eval<boolean>(`(document.querySelector('.fviewer .fviewer-name small')?.textContent ?? '').includes('1 page')`), await page.eval(`document.querySelector('.fviewer .fviewer-name small')?.textContent`));
      await shot('mail-html-phone-pdf');
      await tap(await at('.fviewer .icon-btn[aria-label="Close"]'));
    }
    await asSent(planCard, tap);
    await page.until(`!!document.querySelector(${JSON.stringify(FRAME)})?.contentDocument?.querySelector('.dc-fold')`, 15000);
    check(`${tag}: the quote folds behind ···`, await page.eval<boolean>(`(() => { const d = ${FD}; return d.querySelector('.gmail_quote').classList.contains('dc-folded') && getComputedStyle(d.querySelector('.gmail_quote')).display === 'none'; })()`));
    const h0 = await page.eval<number>(`document.querySelector(${JSON.stringify(FRAME)}).clientHeight`);
    await tap(await inFrame('.dc-fold'));
    check(`${tag}: ··· shows it, and the frame grows`, await page.eval<boolean>(`(() => { const d = ${FD}; return !d.querySelector('.dc-folded') && d.body.innerText.includes('tomatoes go') && document.querySelector(${JSON.stringify(FRAME)}).clientHeight > ${h0}; })()`));
    await page.until(`(() => { const i = ${FD}.querySelector('img[src*="/cid/"]'); return i && i.complete && i.naturalWidth === 300; })()`, 10000);
    check(`${tag}: a picture inside the mail (cid:) shows`, true);
    await shot(`mail-html-${tag.replace(/ /g, '-')}-garden`);
    // And from outside the frame, over the message's head.
    const head = await page.eval<{ left: number; y: number }>(`(() => { const h = document.querySelector(${JSON.stringify(`${planCard} .msg-head`)}); h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { left: r.left, y: Math.round(r.top + r.height / 2) }; })()`);
    await Bun.sleep(300);
    await swipe([Math.round(head.left + 60), head.y], [370, head.y + 4]);
    check(`${tag}: swiping back over the head goes back too`, !(await hash()).includes('/c/'), await hash());
  }

  for (const themeName of ['dither-dark', 'dither-light']) {
    const tag = `html desktop ${themeName}`;
    await page.size(1400, 900);
    await theme(themeName, inList('v:updates:*', autumn.id));
    await asSent(autumnCard, click);
    await page.until(`!!document.querySelector(${JSON.stringify(FRAME)})?.contentDocument?.querySelector('.dc-mail img[src^="/api/mail/img/"]')`, 15000);
    await Bun.sleep(400);
    await stubOpen();
    const t = await page.eval<string>(`${FD}.querySelector('.dc-mail').style.transform`);
    check(`${tag}: a mail that fits is not scaled`, !t.includes('scale'), t);
    await click(await inFrame('a[href="https://library.example/events"]'));
    check(`${tag}: a click opens through the app's opener`, (await opened())[0]?.[0] === 'https://library.example/events', await opened());
    await click(await inFrame('a[href="https://library-events.example/rsvp"]'));
    await page.until(`!!document.querySelector('.cm-root .cm-item')`, 5000);
    check(`${tag}: a link whose text names another site asks first`, (await page.eval<string>(`document.querySelector('.cm-root').textContent`)).includes('goes to library-events.example') && (await opened()).length === 1);
    await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
    await shot(`mail-html-${tag.replace(/ /g, '-')}`);
  }

  const out = [...asked].filter(([id, u]) => !stopped.has(id) && !u.startsWith(base) && !/^(data|blob|about):/.test(u)).map(([, u]) => u);
  check('html: no request left for anywhere but the hub', !out.length, [...new Set(out)].slice(0, 5));
  check('html: the CSP stopped what was put in the frame by hand', [...asked].some(([id, u]) => stopped.has(id) && u.includes('canary')), [...asked].filter(([, u]) => u.includes('canary')).map(([id, u]) => [u, stopped.has(id)]));
}

// ------------------------------------------------------------------ --big: a mailbox of years

const mailNow = () => fetch(`${base}/api/mail`).then((r) => r.json()) as Promise<{ accounts: { sync: { phase: string; synced: number } }[]; mailboxes: { id: string; role: string | null; name: string; total: number | null }[] }>;

async function big(themeName: string, phoneSize: boolean, first: boolean) {
  const tag = `${phoneSize ? 'phone' : 'desktop'} ${themeName} big`;
  if (phoneSize) await page.size(390, 844, true);
  else await page.size(1400, 900);
  const boxes = (await mailNow()).mailboxes;
  const arc = boxes.find((b) => b.role === 'archive')!;
  const projects = boxes.find((b) => b.name === 'Projects')!;
  const rows = () => page.eval<number>(`document.querySelectorAll('.sidebar .mail-row').length`);
  const lastRow = () => page.eval<string>(`[...document.querySelectorAll('.sidebar .mail-row')].at(-1)?.dataset.thread ?? ''`);
  const scroller = '.sidebar .side-scroll';
  const down = async (until: () => Promise<boolean>, tries = 40) => {
    for (let i = 0; i < tries && !(await until()); i++) {
      await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); el.scrollTop = el.scrollHeight; })()`);
      await Bun.sleep(700);
    }
  };
  await theme(themeName, inList(`mb:${arc.id}`));
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 20`, 15000);
  if (first) {
    // While the backfill runs, the last line says so.
    let phase = (await mailNow()).accounts[0].sync.phase;
    for (let i = 0; i < 40 && phase === 'first'; i++) {
      await Bun.sleep(500);
      phase = (await mailNow()).accounts[0].sync.phase;
    }
    const line = `document.querySelector('.sidebar .mail-sync-line')?.textContent ?? ''`;
    if (phase === 'backfill') {
      const ok = await page.until(`/^Syncing older mail · [\\d,.\\s]+, back to /.test(${line})`, 5000).then(() => true, () => false);
      check(`${tag}: the progress line while the backfill runs`, ok, await page.eval<string>(line));
    } else console.log(`note  ${tag}: the backfill was ${phase} when the list showed, so its line was not checked`);
  }
  await down(async () => (await rows()) > 120);
  const n = await rows();
  check(`${tag}: the list goes on as it is scrolled, without a button`, n > 120, n);
  check(`${tag}: no sideways overflow: a long list`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}`);
  if (!first) return;
  for (let i = 0; i < 120 && (await mailNow()).accounts[0].sync.phase !== 'idle'; i++) await Bun.sleep(500);
  check(`${tag}: the backfill ends, and the progress line with it`, (await mailNow()).accounts[0].sync.phase === 'idle' && (await page.until(`!document.querySelector('.sidebar .mail-sync-line')`, 5000).then(() => true, () => false)));

  // A folder the hub does not follow: its first page when opened, then the server's older pages as it is scrolled.
  const held = (await mailNow()).accounts[0].sync.synced;
  await page.eval(`location.hash = ${JSON.stringify(inList(`mb:${projects.id}`))}`);
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 20`, 15000).catch(() => {});
  check(`${tag}: a folder not synced shows its first page when opened`, (await rows()) >= 20, await rows());
  const opened = (await mailNow()).accounts[0].sync.synced;
  await down(async () => (await mailNow()).accounts[0].sync.synced > opened && (await rows()) > 70, 30);
  check(`${tag}: scrolled past it, the folder's older mail comes from the server`, (await mailNow()).accounts[0].sync.synced > opened && opened > held, { held, opened, now: (await mailNow()).accounts[0].sync.synced });
  const last = await lastRow();
  await down(async () => (await lastRow()) !== last, 10);
  const t = ((await fetch(`${base}/api/mail/threads/${await lastRow()}`).then((r) => r.json())) as any).thread;
  check(`${tag}: its rows reach past the year the hub keeps`, t && t.lastAt < Date.now() - 365 * 86_400_000, t && new Date(t.lastAt).toISOString());
  check(`${tag}: no sideways overflow: a folder`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}-folder`);
}

/** Slice 7: searching mail, on a phone and a desktop, in both themes. Runs after the rest (it needs the bodies they opened). */
async function search() {
  // "warranty" is only in the text of an old receipt in a folder the hub does not follow (demo.ts): only the server finds
  // it. Neither run opens it, so its text stays on the server.
  const BOX = '.sidebar input[data-track="mail list: search"]';
  for (const themeName of ['dither-dark', 'dither-light']) {
    let tag = `phone ${themeName}`;
    await page.size(390, 844, true);
    await theme(themeName, inList('v:all:*'));
    await page.until(`!!document.querySelector(${JSON.stringify(BOX)})`, 15000);
    // A mail list's search is the Inbox's box over it (docs/inbox.md "Mail lists"), searching that list.
    const type = async (q: string) => {
      await page.eval(`(() => { const i = document.querySelector(${JSON.stringify(BOX)}); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      // Submitted once the box has drawn with the words (its form submits what it holds).
      await page.until(`document.querySelector(${JSON.stringify(BOX)}).value === ${JSON.stringify(q)}`, 5000);
      await page.eval(`new Promise((r) => requestAnimationFrame(() => r(document.querySelector(${JSON.stringify(BOX)}).form.requestSubmit())))`);
      await page.until(`decodeURIComponent(location.hash).includes(${JSON.stringify(q)})`, 5000);
    };
    // A subject the hub has: its own hit; the server finds the same thread, so nothing shows twice.
    await type('lease');
    check(`${tag}: a mail list's search shows in place of the list`, (await hash()).includes('mail=') && (await page.eval<string>(`document.querySelector(${JSON.stringify(BOX)}).getAttribute('aria-label')`)) === 'Search Everything', await hash());
    await page.until(`!!document.querySelector('.mail-hit') && !document.querySelector('.mail-search .loading') && !/Searching the servers/.test(document.querySelector('.mail-search').textContent)`, 15000);
    const leaseHits = await page.eval<string[]>(`[...document.querySelectorAll('.mail-search .mail-hit')].map((r) => r.dataset.thread)`);
    check(`${tag}: the hub's hit, and the server's same thread not again`, leaseHits.length === 1 && leaseHits[0] === lease.id && !(await has('.mail-search-head')), leaseHits);
    const mails = await mailsOf(lease.id);
    await tap(await at(`.mail-search .mail-hit[data-thread="${lease.id}"]`));
    await page.until(`!!document.querySelector(${JSON.stringify(msg(mails.at(-1).id))})`, 15000);
    check(`${tag}: a hit opens its chat over the results`, (await hash()).includes(`/c/${lease.id}`) && (await inView('.center .mail-thread-pane')), await hash());
    // A chat arriving meanwhile (the demo world's) shows a toast over the chat's header: out of the way first.
    await page.eval(`document.querySelectorAll('.toasts .toast-x').forEach((b) => b.click())`);
    await Bun.sleep(300);
    await tap(await at(`${PANE} .conv-head .icon-btn.back`));
    await Bun.sleep(400);
    check(`${tag}: back goes to the results`, !(await hash()).includes('/c/') && (await inView('.sidebar .mail-search .mail-hit')), await hash());
    // Words in a body the hub holds: marked where they matched.
    await type('signed');
    await page.until(`!!document.querySelector('.mail-search .mail-hit mark')`, 15000);
    check(`${tag}: the hub's hit is marked where it matched`, (await page.eval<string>(`document.querySelector('.mail-search .mail-hit mark').textContent`)).toLowerCase() === 'signed');
    // Words only the server has: they come after the hub's own, under "On the server". A list's search keeps to the list
    // (Everything is all of Inbox), so this one is in all mail, as the search page's "Open in Mail" opens it; the
    // receipt is in a folder the hub does not follow.
    await page.eval(`location.hash = ${JSON.stringify(inList('s:warranty'))}`);
    await page.until(`!!document.querySelector('.mail-search-head') && !/Searching the servers/.test(document.querySelector('.mail-search').textContent)`, 15000);
    const mine = await page.eval<number>(`[...document.querySelectorAll('.mail-search .mail-hit')].filter((r) => !r.matches('.mail-search-head ~ .mail-hit')).length`);
    const theirs = await page.eval<string[]>(`[...document.querySelectorAll('.mail-search-head ~ .mail-hit')].map((r) => r.querySelector('.mail-row-subject')?.textContent ?? '')`);
    check(`${tag}: what only the server has shows under "On the server"`, mine === 0 && theirs.join() === 'Your receipt, order #4102', { mine, theirs });
    check(`${tag}: no sideways overflow: search`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-search`);
    // The filter chips under Mail's search are gone: a filter is words in the box, as the empty search says.
    await type('lease is:unread');
    check(`${tag}: words in the box narrow the search`, (await hash()).includes('is%3Aunread'), await hash());

    tag = `desktop ${themeName}`;
    await page.size(1400, 900);
    await theme(themeName, '#/search?q=signed');
    await page.until(`!!document.querySelector('.mail-search-group .mail-hit')`, 15000);
    check(`${tag}: the search page has a Mail group`, (await page.eval<string>(`document.querySelector('.mail-search-group').textContent`)).includes('Lease renewal'));
    check(`${tag}: its hit is marked where it matched`, (await page.eval<string>(`document.querySelector('.mail-search-group .mail-hit mark')?.textContent ?? ''`)).toLowerCase() === 'signed');
    check(`${tag}: no sideways overflow: search page`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-search-page`);
    await click(await at('.mail-search-group .mail-search-all'));
    await page.until(`decodeURIComponent(location.hash).startsWith('#/inbox?mail=s:signed')`, 5000);
    await page.until(`!!document.querySelector('.sidebar .mail-search .mail-hit')`, 15000);
    check(`${tag}: "Open in Mail" shows the search in the Inbox's place`, (await page.eval<string>(`document.querySelector(${JSON.stringify(BOX)})?.value ?? ''`)) === 'signed');
    await click(await at(`.sidebar .mail-hit[data-thread="${lease.id}"]`));
    await page.until(`!!document.querySelector('.mail-thread-pane .conv-head')`, 15000);
    check(`${tag}: the results and the thread's chat side by side`, (await inView('.sidebar .mail-search')) && (await inView('.center .mail-thread-pane')) && (await has(`.sidebar .mail-hit.active[data-thread="${lease.id}"]`)));
    check(`${tag}: no sideways overflow: a list's search`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-search`);
  }
}

try {
  if (protonRun) {
    await headerless('dither-dark', false, true);
    await headerless('dither-light', true, false);
  } else if (gmailRun) {
    await gmail('dither-dark', false, 'archive');
    await gmail('dither-light', true, 'trash');
    await gmail('dither-light', false, null);
    await gmail('dither-dark', true, null);
  } else {
    if (bigRun) {
      const box = (await mailNow()).mailboxes.find((b) => b.role === 'archive');
      if (!box || (box.total ?? 0) < 1000) throw new Error('no big Archive: start the hub with DITHER_DEMO_MAIL_BIG=1 for --big');
      await big('dither-dark', true, true);
      await big('dither-light', true, false);
      await big('dither-dark', false, false);
      await big('dither-light', false, false);
    }
    await phone('dither-dark', true);
    await phone('dither-light', false);
    await desktop('dither-dark');
    await desktop('dither-light');
    await classification('dither-dark', true);
    await classification('dither-light', true);
    await classification('dither-light', false);
    await classification('dither-dark', false);
    await filing();
    if (withHtml) await htmlChecks();
    await search();
    // Last: it sends, which changes the demo world.
    await composer('dither-light', false);
    await composerDesktop('dither-light', false);
    await composerDesktop('dither-dark', true);
    await composer('dither-dark', true);
  }
  check('no errors on the page', !page.errors.length, page.errors.slice(0, 5));
} catch (e) {
  failed++;
  console.log(`FAIL  ${(e as Error).message}`);
  await shot('mail-failure');
} finally {
  await close();
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
