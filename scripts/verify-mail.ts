/**
 * Mail (docs/mail.md) in headless Chromium against a demo hub, whose fake mail account (hub demo.ts seedDemoMail) has
 * a reply thread with quoted text, a Cc'd thread, list mail, and an HTML-only message with a tracker and scripts. On a
 * phone (390x844, touch) and a desktop, in the dark and the light theme:
 *
 *   - no errors on the page, and nothing runs sideways off the screen;
 *   - the rail's Mail entry, the list, the views in one row of chips (on a phone too);
 *   - on a phone: the list, a thread over it, and back (the button and the browser's back);
 *   - the reader: the latest and unread messages open, the quote folded behind ···, read here after a second; each
 *     folded message (yours too) with the start of its text; on a phone the subject whole, or on two lines with an
 *     ellipsis, beside Archive and ⋯ (Trash and Star are in ⋯);
 *   - an HTML-only message shows (its HTML in the frame, or its text part), and none of its script;
 *   - the Accounts screen's Mail group;
 *   - from a person (slice 8): Inbox folds newsletters and notifications into one Updates row that opens Updates;
 *     People; on a desktop, "Not a person" and "This is a person" from a row's menu.
 *   - filing (slice 4): read in view reaches the server; on a phone a swipe right archives and Undo brings it back,
 *     a swipe left marks unread and read, a long press picks threads and their bar stars them; on a desktop the
 *     reader's star and archive, the `e` key, a row's right-click menu, Ctrl-click picking, and the read setting.
 *   - search (slice 7): Mail's search box, the hub's hits (marked) and what only the server has, a hit opening over the
 *     results and back to them, the filter chips; the search page's Mail group and its way into Mail.
 *   - writing (slice 5), last, since it sends: on a phone, Reply from the reader's bar fills in To, the subject and the
 *     quote; a Cc typed in, a file attached; Send, "Sending… Undo", Undo brings the draft back, Send again, and the
 *     reply joins the thread with its file and reads as text in the app's theme (its plain HTML part is not put on a
 *     white sheet); on a desktop, ✎ docks a new message whose To completes from your mail, and closing it keeps a
 *     draft that opens again from the Drafts line.
 *
 * With --html (slice 3, htmlChecks below), the HTML frame in Chromium: no script runs in it, even put there by hand;
 * no request leaves for anywhere but the hub; a link click goes through the app's opener and never moves the frame,
 * and one whose text names another site asks first; the remote-image banner and the proxy; quotes folded; cid:
 * pictures; files open in the viewers; swiping back over a body works on a phone; a white sheet in both themes.
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
 * line under "Mail" picks the account: its menu has each with the colour of its rows' dot, and says what the dot is.
 *
 * With --gmail (a hub started with DITHER_DEMO_MAIL_GMAIL=1: a Gmail account as dither-accounts' imap extractor gives
 * one), only that account's run, on a phone and a desktop in both themes: it is in the account menu; its labels are in
 * the mailboxes menu and `[Gmail]`, which only holds mailboxes, is not; a label lists its threads; the reader shows
 * the thread's own labels and none of Gmail's (`\Inbox`, `\Important`); one row a thread in Inbox, All Mail and a
 * label; Archive, then Undo before it reaches Gmail, then Archive for good (out of Inbox, still in All Mail and its
 * label), then the reader's Move to Inbox (a copy from All Mail: back in Inbox once, still in All Mail and its label,
 * one message); Move to the trash (out of every mailbox but Trash); nothing off the side.
 *
 *   bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir] [--html] [--big] [--proton] [--gmail]
 * The hub must be a fresh demo hub (--demo) with its own data dir: reading marks threads read.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

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
if (!dinner || !shipped || !lease || !github) throw new Error('the demo mail is not as seeded');

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
async function at(sel: string, pick = 'el => true'): Promise<Pt> {
  const r = await page.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await Bun.sleep(150);
  return r;
}
const has = (sel: string) => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const hash = () => page.eval<string>('location.hash');
/** On screen and not moved off it (the phone's card slides). */
const inView = (sel: string) =>
  page.eval<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.left < innerWidth - 20; })()`);

// ------------------------------------------------------------------ layout (as verify-phone.ts)

const SIDEWAYS = '.level-picker, .ident-chips, .composer-files, .sheet-quick, pre, code, .log-view, .detail-dump, .lv-screen, .mail-chips';
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

/** The theme, then a fresh load of `hash` with it. */
async function theme(name: string, hash: string) {
  await page.goto(`${base}/#/inbox`);
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
  await page.eval(`(location.hash = ${JSON.stringify(hash)}, location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await page.until(`!!document.querySelector('.app')`, 15000);
  // The theme took: a light one draws on a light background.
  const light = await page.eval<boolean>(`(() => { const m = getComputedStyle(document.querySelector('.sidebar')).backgroundColor.match(/\\d+(\\.\\d+)?/g).map(Number); return (m[0] * 0.3 + m[1] * 0.59 + m[2] * 0.11) > 140; })()`);
  check(`${name} is on`, light === name.includes('light'));
}

/** Mail's view chips: how many rows they take, and where the first thread starts (CSS px from the top). */
const chipRows = () =>
  page.eval<{ rows: number; chips: number; firstRow: number }>(`(() => {
    const tops = new Set([...document.querySelectorAll('.sidebar .mail-chips .chip-btn')].map((c) => Math.round(c.getBoundingClientRect().top)));
    const row = document.querySelector('.sidebar .mail-row');
    return { rows: tops.size, chips: document.querySelectorAll('.sidebar .mail-chips .chip-btn').length, firstRow: row ? Math.round(row.getBoundingClientRect().top) : -1 };
  })()`);
/** The reader's subject: its lines, and whether all of it shows. */
const subjectBox = () =>
  page.eval<{ text: string; lines: number; whole: boolean }>(`(() => {
    const el = document.querySelector('.mail-reader .mail-subject');
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { text: el.textContent, lines: Math.round(el.clientHeight / lh), whole: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 };
  })()`);
/** The folded messages: who and the line beside them. */
const foldedLines = () => page.eval<{ who: string; line: string }[]>(`[...document.querySelectorAll('.mail-reader .mail-msg.folded')].map((m) => ({ who: m.querySelector('.mail-msg-who').textContent, line: m.querySelector('.mail-msg-line').textContent }))`);

// ------------------------------------------------------------------ the runs

async function phone(themeName: string, first: boolean) {
  const tag = `phone ${themeName}`;
  await page.size(390, 844, true);
  await theme(themeName, '#/inbox');
  await page.until(`!!document.querySelector('.app.phone')`, 15000);
  await Bun.sleep(600);
  check(`${tag}: the rail has Mail`, await has('.rail .rail-mail'));
  await tap(await at('.rail .rail-btn', `el => !!el.querySelector('.rail-mail')`));
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 10000);
  check(`${tag}: the Mail list shows`, (await hash()).startsWith('#/mail'), await hash());
  check(`${tag}: rows are in the hub's order`, (await page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.dataset.thread)`)).slice(0, 5).join() === inboxThreads.slice(0, 5).map((t) => t.id).join());
  check(`${tag}: no sideways overflow: list`, !(await overflow()).length, await overflow());
  const bar = await chipRows();
  check(`${tag}: the views are one row of chips`, bar.rows === 1 && bar.chips >= 5, bar);
  await shot(`mail-${tag.replace(' ', '-')}-list`);

  // List, then the thread over it, then back.
  await tap(await at(`.sidebar .mail-row[data-thread="${dinner.id}"]`));
  await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
  check(`${tag}: the thread opens as a card over the list`, (await hash()).includes(`/t/${dinner.id}`) && (await inView('.center .mail-reader')), await hash());
  const msgs = await page.eval<{ open: number; folded: number }>(`({ open: document.querySelectorAll('.mail-reader .mail-msg.open').length, folded: document.querySelectorAll('.mail-reader .mail-msg.folded').length })`);
  check(`${tag}: the latest and unread messages open, the read ones folded`, msgs.open === 1 && msgs.folded === 2, msgs);
  check(`${tag}: the quote is folded behind ···`, (await has('.mail-reader .mail-quote-toggle')) && !(await has('.mail-reader .mail-quote')));
  // Yours folds with the start of its text too (its body is asked for when the thread opens).
  await page.until(`[...document.querySelectorAll('.mail-reader .mail-msg.folded .mail-msg-line')].every((l) => l.textContent.trim())`, 10000).catch(() => {});
  const lines = await foldedLines();
  check(`${tag}: every folded message has a snippet, yours too`, lines.length === 2 && lines.every((l) => l.line.trim()) && lines.some((l) => l.who === 'me' && l.line.startsWith('Yes, 7:30 works')), lines);
  const subject = await subjectBox();
  check(`${tag}: the subject shows whole, not cut to a few letters`, subject.whole && subject.text === dinner.subject, subject);
  const head = await page.eval<string[]>(`[...document.querySelectorAll('.mail-reader-head .hdr-btn')].map((b) => b.getAttribute('aria-label'))`);
  check(`${tag}: beside it only Archive and ⋯`, head.join() === 'Archive,More', head);
  if (first) {
    await tap(await at('.mail-reader-head .hdr-btn[aria-label="More"]'));
    await page.until(`!!document.querySelector('.cm-sheet')`, 5000);
    const items = await page.eval<string>(`document.querySelector('.cm-sheet').textContent`);
    check(`${tag}: ⋯ has Star and Move to the trash`, items.includes('Star') && items.includes('Move to the trash'), items);
    await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await page.until(`!document.querySelector('.cm-sheet')`, 5000).catch(() => {});
    await tap(await at('.mail-reader .mail-quote-toggle'));
    check(`${tag}: ··· shows the quote`, await page.eval(`(document.querySelector('.mail-reader .mail-quote')?.textContent ?? '').includes('Should I book a table')`));
    // Read here after a second in view.
    await Bun.sleep(1600);
    const t = (await page1('v:inbox:*')).find((x: any) => x.id === dinner.id);
    check(`${tag}: read here after a second in view`, t?.unread === 0, t?.unread);
  }
  check(`${tag}: no sideways overflow: reader`, !(await overflowThrough('.mail-reader-scroll')).length, await overflowThrough('.mail-reader-scroll'));
  await shot(`mail-${tag.replace(' ', '-')}-reader`);
  await tap(await at('.mail-reader .icon-btn.back'));
  await Bun.sleep(400);
  check(`${tag}: back goes to the list`, !(await hash()).includes('/t/') && (await inView('.sidebar .mail-list')), await hash());

  // The HTML-only message: its HTML in the frame (slice 3), or its text part; none of its script.
  await tap(await at(`.sidebar .mail-row[data-thread="${shipped.id}"]`));
  const shown = `(document.querySelector('.mail-reader .mail-text')?.textContent ?? document.querySelector('.mail-reader .mail-html.ready iframe')?.contentDocument?.body?.innerText ?? '')`;
  await page.until(`${shown}.length > 10`, 15000);
  const text = await page.eval<string>(shown);
  check(`${tag}: an HTML-only message shows`, text.includes('your order #4471 has shipped') && text.includes('Track your parcel'), text.slice(0, 120));
  check(`${tag}: none of its script shows or runs`, !/alert|evil|hacked/.test(text) && !(await page.eval(`document.title.includes('hacked')`)));
  await page.eval('history.back()');
  await Bun.sleep(500);
  check(`${tag}: the browser's back goes to the list too`, !(await hash()).includes('/t/'), await hash());
  if (first) {
    // A long subject: two lines, then an ellipsis.
    await page.eval(`location.hash = '#/mail/t/${github.id}'`);
    await page.until(`document.querySelector('.mail-reader .mail-subject')?.textContent === ${JSON.stringify(github.subject)}`, 10000);
    await Bun.sleep(400);
    const long = await subjectBox();
    check(`${tag}: a long subject takes two lines, then an ellipsis`, long.lines === 2 && !long.whole, long);
    await shot(`mail-${tag.replace(' ', '-')}-reader-long-subject`);
    await page.eval(`location.hash = '#/mail'`);
    await page.until(`!location.hash.includes('/t/')`, 5000);
    await Bun.sleep(500);
  }

  // A view chip, then the Accounts screen's Mail group.
  await tap(await at('.sidebar .mail-chips .chip-btn', `el => el.textContent === 'Sent'`));
  await page.until(`location.hash.includes('v%3Asent')`, 5000);
  check(`${tag}: Sent lists what you sent`, (await page.eval<number>(`document.querySelectorAll('.sidebar .mail-row').length`)) >= 3);
  await page.goto(`${base}/#/accounts`);
  await page.until(`!!document.querySelector('.acc-mail-group .mail-acc')`, 10000);
  check(`${tag}: Accounts has a Mail group with the account`, (await page.eval<string>(`document.querySelector('.acc-mail-group').textContent`)).includes('zyan@dither.example'));
  check(`${tag}: no sideways overflow: accounts`, !(await overflow()).length, await overflow());
}

async function desktop(themeName: string) {
  const tag = `desktop ${themeName}`;
  await page.size(1400, 900);
  await theme(themeName, '#/mail');
  await page.until(`document.querySelectorAll('.sidebar .mail-row').length >= 5`, 15000);
  check(`${tag}: no thread open yet: the welcome pane`, await has('.center .welcome'));
  const bar = await chipRows();
  check(`${tag}: the views are one row of chips`, bar.rows === 1 && bar.chips >= 5, bar);
  await click(await at(`.sidebar .mail-row[data-thread="${lease.id}"]`));
  await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
  check(`${tag}: the list and the reader side by side`, (await inView('.sidebar .mail-list')) && (await inView('.center .mail-reader')));
  // The first message, folded (read), opens with its Cc.
  await click(await at('.mail-reader .mail-msg.folded'));
  await page.until(`document.querySelectorAll('.mail-reader .mail-msg.open .mail-text').length >= 2`, 15000);
  check(`${tag}: a folded message opens, with its Cc`, (await page.eval<string>(`[...document.querySelectorAll('.mail-reader .mail-msg-to')].map((e) => e.textContent).join(' | ')`)).includes('cc Jo Park'));
  check(`${tag}: the open row is marked`, await has(`.sidebar .mail-row.active[data-thread="${lease.id}"]`));
  check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(' ', '-')}`);
  // The switcher finds Mail and its mailboxes.
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
  await Bun.sleep(200);
  await page.eval(`(() => { const i = document.querySelector('.switcher-input'); i.value = 'Archive'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await Bun.sleep(200);
  check(`${tag}: Ctrl+K finds a mailbox`, (await page.eval<string>(`document.querySelector('.switcher-list').textContent`)).includes('Mailbox'));
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`);
}

// ------------------------------------------------------------------ writing (slice 5)

/** Text typed into a field, as a person would (the input event the page listens for). */
const type = (sel: string, text: string) =>
  page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const key = (sel: string, k: string) => page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
const outbox = async () => ((await fetch(`${base}/api/mail/outbox`).then((r) => r.json())) as any).items as any[];
const threadNow = async (id: string) => (await fetch(`${base}/api/mail/threads/${id}`).then((r) => r.json())) as any;
/** A file for the file picker, through the browser's own protocol. */
async function pickFile(sel: string, path: string) {
  const r = await page.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` });
  await page.send('DOM.setFileInputFiles', { files: [path], objectId: r.result.objectId });
}

async function composer(themeName: string, full: boolean) {
  const tag = `composer phone ${themeName}`;
  await page.size(390, 844, true);
  await theme(themeName, `#/mail/t/${dinner.id}`);
  await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
  const before = (await threadNow(dinner.id)).messages.length;
  check(`${tag}: the reader's bar answers`, (await page.eval<string>(`document.querySelector('.mail-reader-bar')?.textContent ?? ''`)).includes('Reply'));
  await tap(await at('.mail-reader-bar .hdr-btn', `el => el.textContent.trim() === 'Reply'`));
  await page.until(`!!document.querySelector('.mc-layer.phone .mc-body')`, 15000);
  check(`${tag}: Reply opens the composer full screen`, await inView('.mc-layer.phone .mc'));
  const filled = await page.eval<{ to: string; subject: string; quote: boolean }>(`({ to: [...document.querySelectorAll('.mc-chip')].map((c) => c.textContent).join(','), subject: document.querySelector('.mc-subject').value, quote: !!document.querySelector('.mc-quote .mail-quote-toggle') })`);
  check(`${tag}: To, the subject and the quote are filled in`, filled.to.includes('Sam Rivera') && filled.subject === 'Re: Dinner on Friday?' && filled.quote, filled);
  check(`${tag}: no sideways overflow`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(/ /g, '-')}`);
  if (!full) {
    await tap(await at('.mc-head .icon-btn'));
    await Bun.sleep(300);
    check(`${tag}: ✕ closes it`, !(await has('.mc-layer')));
    return;
  }
  // A Cc typed in, the text, a file.
  await tap(await at('.mc-more .link-btn', `el => el.textContent === 'Cc'`));
  await type('#mc-cc', 'jo@park.example');
  await key('#mc-cc', 'Enter');
  await Bun.sleep(150);
  check(`${tag}: a typed Cc becomes a chip`, await page.eval(`[...document.querySelectorAll('.mc-chip')].some((c) => c.textContent.includes('jo@park.example'))`));
  await type('.mc-body', 'See you at 7:30!');
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
  await page.until(`document.querySelector('.mc-body')?.value === 'See you at 7:30!'`, 10000);
  check(`${tag}: Undo brings the draft back, file and all`, (await has('.mc-files .composer-file')) && (await page.eval(`[...document.querySelectorAll('.mc-chip')].some((c) => c.textContent.includes('jo@park.example'))`)));
  check(`${tag}: nothing went`, !(await outbox()).some((o: any) => o.state === 'sent' && o.threadId === dinner.id));
  // Send again, and let it go.
  await tap(await at('.mc-send'));
  await page.until(`!!document.querySelector('.mc-strip .mc-out')`, 10000);
  const end = Date.now() + 30_000;
  while (Date.now() < end && !(await outbox()).some((o: any) => o.state === 'sent' && o.threadId === dinner.id)) await Bun.sleep(250);
  await page.until(`!!document.querySelector('.mc-strip .mc-out.sent')`, 5000).catch(() => {});
  check(`${tag}: then "Sent"`, await has('.mc-strip .mc-out.sent'));
  const end2 = Date.now() + 10_000;
  let after = await threadNow(dinner.id);
  while (Date.now() < end2 && after.messages.length === before) {
    await Bun.sleep(250);
    after = await threadNow(dinner.id);
  }
  const mine = after.messages[after.messages.length - 1];
  check(`${tag}: the reply joins the thread, with its Cc and its file`, after.messages.length === before + 1 && mine.addressed === 'self' && mine.cc.some((a: any) => a.email === 'jo@park.example') && mine.hasAttachments, { n: after.messages.length, cc: mine?.cc, files: mine?.hasAttachments });
  await page.until(`document.querySelectorAll('.mail-reader .mail-msg').length >= ${before + 1}`, 10000).catch(() => {});
  check(`${tag}: the reader shows it`, (await page.eval<number>(`document.querySelectorAll('.mail-reader .mail-msg').length`)) >= before + 1);
  // Its HTML part is plain (text, a quote, a link): it reads as text in the app's theme, not on a white sheet.
  const body = (await fetch(`${base}/api/mail/messages/${mine.id}/body`).then((r) => r.json())) as any;
  check(`${tag}: the hub calls its HTML plain`, !!body.html && body.html.plain === true, body.html);
  for (const t of [themeName, themeName === 'dither-dark' ? 'dither-light' : 'dither-dark']) {
    await theme(t, `#/mail/t/${dinner.id}`);
    const card = `.mail-reader .mail-msg[data-message="${mine.id}"]`;
    await page.until(`!!document.querySelector(${JSON.stringify(card)})`, 10000);
    if (await has(`${card}.folded`)) {
      check(`composer phone ${t}: folded, your reply has its snippet`, (await page.eval<string>(`document.querySelector('${card} .mail-msg-line').textContent`)).startsWith('See you at 7:30!'));
      await tap(await at(card));
    }
    await page.until(`!!document.querySelector('${card}.open .mail-text')`, 10000).catch(() => {});
    const shown = await page.eval<{ text: string; sheet: boolean; color: string }>(
      `(() => { const c = document.querySelector('${card}.open'); return { text: c?.querySelector('.mail-text')?.textContent ?? '', sheet: !!c?.querySelector('.mail-html, .mail-sheet'), color: c ? getComputedStyle(c.querySelector('.mail-msg-body')).backgroundColor : '' }; })()`,
    );
    check(`composer phone ${t}: a plain reply shows as text, with its quote folded, no white sheet`, shown.text.startsWith('See you at 7:30!') && !shown.sheet && (await has(`${card} .mail-quote-toggle`)), shown);
    await page.eval(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
    await shot(`mail-composer-phone-${t}-plain-reply`);
  }
}

async function composerDesktop(themeName: string, full: boolean) {
  const tag = `composer desktop ${themeName}`;
  await page.size(1400, 900);
  await theme(themeName, '#/mail');
  await page.until(`!!document.querySelector('.sidebar .mail-compose-btn')`, 15000);
  await click(await at('.sidebar .mail-compose-btn'));
  await page.until(`!!document.querySelector('.mc-layer.dock #mc-to')`, 15000);
  const box = await page.eval<{ right: number; bottom: number; w: number }>(`(() => { const r = document.querySelector('.mc-layer.dock .mc').getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, w: r.width }; })()`);
  check(`${tag}: ✎ docks a new message at the bottom right`, box.right >= 0 && box.right < 40 && box.bottom >= 0 && box.bottom < 40 && box.w < 700, box);
  check(`${tag}: the list stays usable beside it`, await inView('.sidebar .mail-list'));
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
  check(`${tag}: picking one makes a chip`, await page.eval(`[...document.querySelectorAll('.mc-chip')].some((c) => c.textContent.includes('Sam'))`));
  await type('#mc-subject', 'Photos from Friday');
  await type('.mc-body', 'Here they are.');
  // Closed: kept as a draft, which the Drafts line opens again.
  await Bun.sleep(300);
  await click(await at('.mc-head .icon-btn'));
  await page.until(`!!document.querySelector('.mail-drafts-line')`, 8000).catch(() => {});
  check(`${tag}: closing keeps a draft`, (await page.eval<string>(`document.querySelector('.mail-drafts-line')?.textContent ?? ''`)).includes('1 draft'));
  await click(await at('.mail-drafts-line'));
  await click(await at('.cm-item, .context-menu button, [role=menuitem]', `el => el.textContent.includes('Photos from Friday')`));
  await page.until(`document.querySelector('.mc-body')?.value === 'Here they are.'`, 8000).catch(() => {});
  check(`${tag}: the draft opens again as it was`, (await page.eval(`document.querySelector('.mc-subject')?.value`)) === 'Photos from Friday');
  await click(await at('.mc-discard'));
  await page.until(`!document.querySelector('.mail-drafts-line')`, 8000).catch(() => {});
  check(`${tag}: discarding it removes the draft`, !(await has('.mail-drafts-line')));
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
  await page.eval(`location.hash = '#/mail'`);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.textContent.includes('Found your scarf'))`, 15000);
  check(`${tag}: Inbox shows the stranger's note, not the newsletter`, !(await rows()).some((r) => r.includes('Garden Club Weekly')));
  check(`${tag}: no sideways overflow: Inbox`, !(await overflow()).length, await overflow());

  // Two accounts: the line under "Mail" picks whose mail the views show, and its menu says what the rows' dots are.
  const press = onPhone ? tap : click;
  const bar = await chipRows();
  check(`${tag}: the views are one row of chips`, bar.rows === 1, bar);
  check(`${tag}: the line under "Mail" says All accounts`, (await page.eval<string>(`document.querySelector('.sidebar .side-head .mail-acc-btn')?.textContent ?? ''`)) === 'All accounts');
  await press(await at('.sidebar .mail-acc-btn'));
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
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`v:inbox:${PROTON}`))})`, 5000);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.textContent.includes('Found your scarf'))`, 10000);
  check(
    `${tag}: picking an account shows its mail only, and the line says which`,
    (await page.eval<string>(`document.querySelector('.sidebar .mail-acc-btn').textContent`)) === 'zyan@proton.example' && !(await rows()).some((r) => r.includes('Dinner')),
  );
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-one-account`);
  await press(await at('.sidebar .mail-acc-btn'));
  await press(await menuItem('All accounts'));
  await page.until(`document.querySelector('.sidebar .mail-acc-btn')?.textContent === 'All accounts'`, 5000).catch(() => {});
  check(`${tag}: and All accounts again`, (await page.eval<string>(`document.querySelector('.sidebar .mail-acc-btn')?.textContent ?? ''`)) === 'All accounts');
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
  await theme(themeName, '#/mail');
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 3`, 15000);
  const rows = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.dataset.thread)`);

  // The account menu under "Mail".
  await press(await at('.sidebar .mail-acc-btn'));
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  const accMenu = await page.eval<string>(`(document.querySelector('.cm-sheet') ?? document.querySelector('.cm')).textContent`);
  check(`${tag}: the account menu has the Gmail account`, accMenu.includes(GMAIL_ME) && accMenu.includes('All accounts'), accMenu);
  await press(await menuItem(GMAIL_ME));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`v:inbox:${GMAIL_ACC}`))})`, 5000);
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 2`, 10000);
  const inboxRows = await rows();
  check(`${tag}: its Inbox, each thread once`, inboxRows.includes(coast.id) && new Set(inboxRows).size === inboxRows.length, inboxRows.length);
  check(`${tag}: no sideways overflow: its Inbox`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-inbox`);

  // The mailboxes menu: Inbox, the labels, Gmail's own; not `[Gmail]`, which only holds them.
  await press(await at('.sidebar .mail-boxes-btn'));
  await page.until(`!!document.querySelector('.cm, .cm-sheet')`, 5000);
  const items = await page.eval<string[]>(`[...(document.querySelector('.cm-sheet') ?? document.querySelector('.cm')).querySelectorAll('.cm-item, button')].map((b) => b.textContent.trim()).filter(Boolean)`);
  check(`${tag}: the mailboxes menu has its labels and Gmail's mailboxes`, ['Travel', 'Family', '[Gmail] / All Mail', '[Gmail] / Spam', '[Gmail] / Trash'].every((x) => items.includes(x)), items);
  check(`${tag}: and not [Gmail], which only holds mailboxes`, !items.includes('[Gmail]'), items);
  check(`${tag}: no sideways overflow: the mailboxes menu`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-mailboxes`);
  await press(await menuItem('Travel'));
  await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`mb:${travel.id}`))})`, 5000);
  await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.dataset.thread === ${JSON.stringify(coast.id)})`, 10000);
  const travelRows = await rows();
  check(`${tag}: a label lists its threads, each once`, travelRows.includes(coast.id) && new Set(travelRows).size === travelRows.length, travelRows.length);
  check(`${tag}: no sideways overflow: a label`, !(await overflow()).length, await overflow());
  await shot(`mail-${sz}-${themeName}-gmail-label`);

  // The reader: the thread's own label, none of Gmail's.
  await press(await at(`.sidebar .mail-row[data-thread="${coast.id}"]`));
  await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
  const readerText = await page.eval<string>(`document.querySelector('.mail-reader').textContent`);
  check(`${tag}: the reader shows Travel and no \\Inbox or \\Important`, readerText.includes('Travel') && !/\\(Inbox|Important|Sent|Starred)/.test(readerText));
  check(`${tag}: no sideways overflow: reader`, !(await overflowThrough('.mail-reader-scroll')).length, await overflowThrough('.mail-reader-scroll'));
  await shot(`mail-${sz}-${themeName}-gmail-reader`);

  if (step === 'archive') {
    // Garden photos, from Family: Archive, Undo before it reaches Gmail, then Archive for good.
    const photos = find('Garden photos');
    await page.eval(`location.hash = '#/mail/t/${photos.id}'`);
    await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
    await press(await at('.mail-reader-head .hdr-btn[aria-label="Archive"]'));
    await page.until(`!!document.querySelector('.mail-undo .link-btn')`, 5000);
    check(`${tag}: Archive shows "Archived · Undo"`, (await page.eval<string>(`document.querySelector('.mail-undo')?.textContent ?? ''`)).includes('Archived'));
    await press(await at('.mail-undo .link-btn'));
    check(`${tag}: Undo brings it back before Gmail heard of it`, await settled(photos.id, (t) => t.roles.includes('inbox')));
    await page.eval(`location.hash = '#/mail/t/${photos.id}'`);
    await page.until(`!!document.querySelector('.mail-reader-head .hdr-btn[aria-label="Archive"]')`, 15000);
    await press(await at('.mail-reader-head .hdr-btn[aria-label="Archive"]'));
    check(`${tag}: Archive for good: out of Inbox, in All Mail`, await settled(photos.id, (t) => !t.roles.includes('inbox') && t.roles.includes('all')));
    const [inAll, inFamily, inbox] = [await page1(`mb:${all.id}`), await page1(`mb:${family.id}`), await page1(`v:inbox:${GMAIL_ACC}`)];
    check(`${tag}: once in All Mail, still in Family, not in Inbox`, inAll.filter((t) => t.id === photos.id).length === 1 && inFamily.some((t) => t.id === photos.id) && !inbox.some((t) => t.id === photos.id));
    await shot(`mail-${sz}-${themeName}-gmail-archived`);

    // Move to Inbox from All Mail: the extractor copies it there (a move out of All Mail would delete it on Gmail).
    const before = await hubThread(photos.id);
    await page.eval(`location.hash = '#/mail/t/${photos.id}'`);
    await page.until(`!!document.querySelector('.mail-reader-head .hdr-btn[aria-label="Move to Inbox"]')`, 15000);
    await press(await at('.mail-reader-head .hdr-btn[aria-label="Move to Inbox"]'));
    await page.until(`!!document.querySelector('.mail-undo')`, 5000).catch(() => {});
    check(`${tag}: Move to Inbox shows "Moved to Inbox · Undo"`, (await page.eval<string>(`document.querySelector('.mail-undo')?.textContent ?? ''`)).includes('Moved to Inbox'));
    check(`${tag}: Move to Inbox from All Mail: in Inbox and All Mail`, await settled(photos.id, (t) => t.roles.includes('inbox') && t.roles.includes('all')));
    const back = await hubThread(photos.id);
    const [inAll2, inFamily2, inbox2] = [await page1(`mb:${all.id}`), await page1(`mb:${family.id}`), await page1(`v:inbox:${GMAIL_ACC}`)];
    const named = (ts: any[]) => ts.filter((t) => t.subject === photos.subject).length;
    check(
      `${tag}: back in Inbox once, still once in All Mail and in Family, one message`,
      named(inbox2) === 1 && inbox2.some((t) => t.id === photos.id) && named(inAll2) === 1 && inFamily2.some((t) => t.id === photos.id) && back.count === before.count && back.labels.join() === 'Family',
      { inbox: named(inbox2), all: named(inAll2), count: [before.count, back.count], labels: back.labels },
    );
    await page.eval(`location.hash = '#/mail/l/${encodeURIComponent(`v:inbox:${GMAIL_ACC}`)}'`);
    await page.until(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].some((r) => r.dataset.thread === ${JSON.stringify(photos.id)})`, 10000).catch(() => {});
    const inboxRows2 = await rows();
    check(`${tag}: its row is in the Inbox list once`, inboxRows2.filter((id) => id === photos.id).length === 1, inboxRows2.length);
    await shot(`mail-${sz}-${themeName}-gmail-back-in-inbox`);
  }
  if (step === 'trash') {
    // The booking, archived under Travel: to the trash, out of All Mail and Travel.
    const hotel = find('Your booking is confirmed');
    await page.eval(`location.hash = '#/mail/t/${hotel.id}'`);
    await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
    if (onPhone) {
      await press(await at('.mail-reader-head .hdr-btn[aria-label="More"]'));
      await page.until(`!!document.querySelector('.cm-sheet')`, 5000);
      await press(await menuItem('Move to the trash'));
    } else await press(await at('.mail-reader-head .hdr-btn[aria-label="Move to the trash"]'));
    check(`${tag}: Move to the trash: in Trash alone`, await settled(hotel.id, (t) => t.roles.join() === 'trash'));
    const [inAll, inTravel] = [await page1(`mb:${all.id}`), await page1(`mb:${travel.id}`)];
    check(`${tag}: out of All Mail and Travel`, !inAll.some((t) => t.id === hotel.id) && !inTravel.some((t) => t.id === hotel.id));
    check(`${tag}: no sideways overflow: after the trash`, !(await overflow()).length, await overflow());
    await shot(`mail-${sz}-${themeName}-gmail-trashed`);
  }
}

// ------------------------------------------------------------------ from a person (slice 8)

const UPDATES = `#/mail/l/${encodeURIComponent('v:updates:*')}`;

/**
 * Inbox folds the newsletters and notifications into one Updates row, which opens the Updates view; People holds the
 * rest; a thread's menu says "Not a person" (to Updates) or "This is a person" (back), on Theo's thread, which no
 * other run uses.
 */
async function classification(themeName: string, onPhone: boolean) {
  const tag = `${onPhone ? 'phone' : 'desktop'} ${themeName}: from a person`;
  const go = onPhone ? tap : click;
  if (onPhone) await page.size(390, 844, true);
  else await page.size(1400, 900);
  await theme(themeName, '#/mail');
  await page.until(`!!document.querySelector('.sidebar .mail-updates-row')`, 15000);
  const shownIds = () => page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row[data-thread]')].map((r) => r.dataset.thread)`);
  const bulk = new Set(updateThreads.map((t) => t.id));
  check(`${tag}: Inbox shows no newsletters or notifications`, !(await shownIds()).some((id) => bulk.has(id)));
  const fold = await page.eval<string>(`document.querySelector('.sidebar .mail-updates-row').textContent`);
  check(`${tag}: one Updates row says how many are new, and from whom`, /Updates\d+ new/.test(fold) && /This Week in Rust|GitHub|Maple Street Library/.test(fold), fold);
  check(`${tag}: no sideways overflow: Inbox with its Updates row`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-updates-row`);
  await go(await at('.sidebar .mail-updates-row'));
  await page.until(`location.hash.includes('v%3Aupdates')`, 5000);
  await page.until(`document.querySelectorAll('.sidebar .mail-row[data-thread]').length >= 5`, 10000);
  const upd = await shownIds();
  check(`${tag}: it opens Updates: the mail not from a person`, upd.length >= 5 && upd.every((id) => bulk.has(id)), upd.length);
  check(`${tag}: Updates has its chip while you are in it`, await has('.sidebar .mail-chips .chip-btn.on'));
  check(`${tag}: no sideways overflow: Updates`, !(await overflow()).length, await overflow());
  await shot(`mail-${onPhone ? 'phone' : 'desktop'}-${themeName}-updates`);
  await go(await at('.sidebar .mail-chips .chip-btn', `el => el.textContent === 'People'`));
  await page.until(`location.hash.includes('v%3Apeople')`, 5000);
  await Bun.sleep(600);
  const ppl = await shownIds();
  check(`${tag}: People: Dinner and the lease, no newsletters`, ppl.includes(dinner.id) && ppl.includes(lease.id) && !ppl.some((id) => bulk.has(id)), ppl.length);
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
    check(`${tag}: "Archived · Undo" shows`, (await page.eval<string>(`document.querySelector('.mail-undo')?.textContent ?? ''`)).includes('Archived'));
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
    check(`${tag}: then a tap picks another, and does not open it`, (await picked()).sort().join() === [a.id, b.id].sort().join() && !(await hash()).includes('/t/'), await picked());
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
    await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
    const head = await page.eval<string[]>(`[...document.querySelectorAll('.mail-reader-head .hdr-btn')].map((b) => b.getAttribute('aria-label'))`);
    check(`${tag}: the reader has Archive, Trash, Star and More`, ['Archive', 'Move to the trash', 'Star', 'More'].every((l) => head.includes(l)), head);
    await click(await at('.mail-reader-head .hdr-btn[aria-label="Star"]'));
    check(`${tag}: Star stars it`, (await has('.mail-reader-head .hdr-btn[aria-label="Unstar"]')) && (await settled(c.id, (t) => t.flagged, 'it starred')));
    await click(await at('.mail-reader-head .hdr-btn[aria-label="Unstar"]'));
    check(`${tag}: Unstar unstars it`, await settled(c.id, (t) => !t.flagged, 'it unstarred'));
    await shot(`mail-desktop-${themeName}-reader`);
    await key('e');
    await Bun.sleep(400);
    check(`${tag}: e archives the open thread and goes back to the list`, !(await hash()).includes('/t/') && !(await has(row(c.id))) && (await settled(c.id, (t) => !t.roles.includes('inbox'), 'it archived')));
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

const FRAME = '.mail-reader .mail-html.ready iframe.mail-frame';
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

async function htmlChecks() {
  const autumn = byTitle('Autumn at the library');
  const garden = byTitle('The garden plan');
  if (!autumn || !garden) throw new Error('the demo has no HTML mail (hub demo-html.ts)');
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
    await theme(themeName, `#/mail/t/${autumn.id}`);
    await page.until(`!!document.querySelector(${JSON.stringify(FRAME)})?.contentDocument?.querySelector('.dc-mail')`, 15000);
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
    check(`${tag}: no sideways overflow: HTML reader`, !(await overflowThrough('.mail-reader-scroll')).length, await overflowThrough('.mail-reader-scroll'));

    // The image banner, then the images through the hub.
    if (first) {
      const banner = await page.eval<string>(`document.querySelector('.mail-img-banner')?.textContent ?? ''`);
      check(`${tag}: remote images held back, with a banner`, /\d+ remote images hidden/.test(banner) && banner.includes('a tracker removed') && banner.includes('Always from Maple Street Library'), banner);
      check(`${tag}: placeholders where they were`, (await page.eval<number>(`${FD}.querySelectorAll('.dc-img-blocked').length`)) >= 2);
      await shot('mail-html-phone-blocked');
      await tap(await at('.mail-img-banner .link-btn', `el => el.textContent.trim() === 'Load'`));
      await page.until(`(() => { const d = ${FD}; const im = [...(d?.querySelectorAll('img') ?? [])].filter((i) => i.getAttribute('src')?.startsWith('/api/mail/img/')); return im.length >= 2 && im.every((i) => i.complete && i.naturalWidth > 0); })()`, 15000);
      check(`${tag}: Load shows them, through the hub`, !(await has('.mail-img-banner')));
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
    check(`${tag}: swiping back over the body goes back`, !(await hash()).includes('/t/') && (await inView('.sidebar .mail-list')), await hash());

    // Quotes folded, a cid: picture, and the files.
    await tap(await at(`.sidebar .mail-row[data-thread="${garden.id}"]`));
    await page.until(`!!document.querySelector(${JSON.stringify(FRAME)})?.contentDocument?.querySelector('.dc-fold')`, 15000);
    check(`${tag}: the quote folds behind ···`, await page.eval<boolean>(`(() => { const d = ${FD}; return d.querySelector('.gmail_quote').classList.contains('dc-folded') && getComputedStyle(d.querySelector('.gmail_quote')).display === 'none'; })()`));
    const h0 = await page.eval<number>(`document.querySelector(${JSON.stringify(FRAME)}).clientHeight`);
    await tap(await inFrame('.dc-fold'));
    check(`${tag}: ··· shows it, and the frame grows`, await page.eval<boolean>(`(() => { const d = ${FD}; return !d.querySelector('.dc-folded') && d.body.innerText.includes('tomatoes go') && document.querySelector(${JSON.stringify(FRAME)}).clientHeight > ${h0}; })()`));
    await page.until(`(() => { const i = ${FD}.querySelector('img[src*="/cid/"]'); return i && i.complete && i.naturalWidth === 300; })()`, 10000);
    check(`${tag}: a picture inside the mail (cid:) shows`, true);
    const cards = await page.eval<string[]>(`[...document.querySelectorAll('.mail-reader .mail-files .att-file b')].map((b) => b.textContent)`);
    check(`${tag}: the files, but not the picture the mail shows itself`, cards.join() === 'seeds.txt,garden-plan.pdf', cards);
    if (first) {
      await tap(await at('.mail-reader .mail-files .att-file', `el => el.textContent.includes('seeds.txt')`));
      await page.until(`(document.querySelector('.fviewer')?.textContent ?? '').includes('San Marzano')`, 10000);
      check(`${tag}: a text file opens in the viewer`, true);
      await tap(await at('.fviewer .icon-btn[aria-label="Close"]'));
      await tap(await at('.mail-reader .mail-files .att-file', `el => el.textContent.includes('garden-plan.pdf')`));
      await page.until(`!!document.querySelector('.fviewer[data-kind="pdf"] .fv-page canvas, .fviewer[data-kind="pdf"] .fv-page')`, 20000);
      check(`${tag}: a PDF opens in the viewer`, await page.eval<boolean>(`(document.querySelector('.fviewer .fviewer-name small')?.textContent ?? '').includes('1 page')`), await page.eval(`document.querySelector('.fviewer .fviewer-name small')?.textContent`));
      await shot('mail-html-phone-pdf');
      await tap(await at('.fviewer .icon-btn[aria-label="Close"]'));
    }
    await shot(`mail-html-${tag.replace(/ /g, '-')}-garden`);
    // And from outside the frame, over the message's header, with slice 4's buttons in the reader.
    const head = await page.eval<{ left: number; y: number }>(`(() => { const h = document.querySelector('.mail-reader .mail-msg.open .mail-msg-head'); h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { left: r.left, y: Math.round(r.top + r.height / 2) }; })()`);
    await Bun.sleep(300);
    await swipe([Math.round(head.left + 60), head.y], [370, head.y + 4]);
    check(`${tag}: swiping back over the header goes back too`, !(await hash()).includes('/t/') && (await inView('.sidebar .mail-list')), await hash());
  }

  for (const themeName of ['dither-dark', 'dither-light']) {
    const tag = `html desktop ${themeName}`;
    await page.size(1400, 900);
    await theme(themeName, `#/mail/t/${autumn.id}`);
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
  await theme(themeName, `#/mail/l/${encodeURIComponent(`mb:${arc.id}`)}`);
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
  await page.eval(`location.hash = ${JSON.stringify(`#/mail/l/${encodeURIComponent(`mb:${projects.id}`)}`)}`);
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
  for (const themeName of ['dither-dark', 'dither-light']) {
    let tag = `phone ${themeName}`;
    await page.size(390, 844, true);
    await theme(themeName, '#/mail');
    await page.until(`!!document.querySelector('.sidebar .mail-search-btn')`, 15000);
    await tap(await at('.sidebar .mail-search-btn'));
    await page.until(`!!document.querySelector('.mail-search-box input')`, 5000);
    check(`${tag}: Mail's search opens in place of the list`, (await hash()).startsWith('#/mail/l/s%3A') && !(await has('.sidebar .mail-chips .chip-btn[role=radio]')), await hash());
    const type = async (q: string) => {
      await page.eval(`(() => { const i = document.querySelector('.mail-search-box input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit(); })()`);
      await page.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(`s:${q}`))})`, 5000);
    };
    // A subject the hub has: its own hit; the server finds the same thread, so nothing shows twice.
    await type('lease');
    await page.until(`!!document.querySelector('.mail-hit') && !document.querySelector('.mail-search .loading') && !/Searching the servers/.test(document.querySelector('.mail-search').textContent)`, 15000);
    const leaseHits = await page.eval<string[]>(`[...document.querySelectorAll('.mail-search .mail-hit')].map((r) => r.dataset.thread)`);
    check(`${tag}: the hub's hit, and the server's same thread not again`, leaseHits.length === 1 && leaseHits[0] === lease.id && !(await has('.mail-search-head')), leaseHits);
    await tap(await at(`.mail-search .mail-hit[data-thread="${lease.id}"]`));
    await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
    check(`${tag}: a hit opens over the results`, (await hash()).includes(`/t/${lease.id}`) && (await inView('.center .mail-reader')), await hash());
    // A chat arriving meanwhile (the demo world's) shows a toast over the reader's header: out of the way first.
    await page.eval(`document.querySelectorAll('.toasts .toast-x').forEach((b) => b.click())`);
    await Bun.sleep(300);
    await tap(await at('.mail-reader .icon-btn.back'));
    await Bun.sleep(400);
    check(`${tag}: back goes to the results`, !(await hash()).includes('/t/') && (await inView('.sidebar .mail-search .mail-hit')), await hash());
    // Words in a body the hub holds: marked where they matched.
    await type('signed');
    await page.until(`!!document.querySelector('.mail-search .mail-hit mark')`, 15000);
    check(`${tag}: the hub's hit is marked where it matched`, (await page.eval<string>(`document.querySelector('.mail-search .mail-hit mark').textContent`)).toLowerCase() === 'signed');
    // Words only the server has: they come after the hub's own, under "On the server".
    await type('warranty');
    await page.until(`!!document.querySelector('.mail-search-head') && !/Searching the servers/.test(document.querySelector('.mail-search').textContent)`, 15000);
    const mine = await page.eval<number>(`[...document.querySelectorAll('.mail-search .mail-hit')].filter((r) => !r.matches('.mail-search-head ~ .mail-hit')).length`);
    const theirs = await page.eval<string[]>(`[...document.querySelectorAll('.mail-search-head ~ .mail-hit')].map((r) => r.querySelector('.mail-row-subject')?.textContent ?? '')`);
    check(`${tag}: what only the server has shows under "On the server"`, mine === 0 && theirs.join() === 'Your receipt, order #4102', { mine, theirs });
    check(`${tag}: no sideways overflow: search`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-search`);
    await tap(await at('.mail-search-chips .chip-btn', `el => el.textContent === 'Unread'`));
    await page.until(`location.hash.includes('is%3Aunread')`, 5000);
    check(`${tag}: a chip narrows the search`, true);

    tag = `desktop ${themeName}`;
    await page.size(1400, 900);
    await theme(themeName, '#/search?q=signed');
    await page.until(`!!document.querySelector('.mail-search-group .mail-hit')`, 15000);
    check(`${tag}: the search page has a Mail group`, (await page.eval<string>(`document.querySelector('.mail-search-group').textContent`)).includes('Lease renewal'));
    check(`${tag}: its hit is marked where it matched`, (await page.eval<string>(`document.querySelector('.mail-search-group .mail-hit mark')?.textContent ?? ''`)).toLowerCase() === 'signed');
    check(`${tag}: no sideways overflow: search page`, !(await overflow()).length, await overflow());
    await shot(`mail-${tag.replace(' ', '-')}-search-page`);
    await click(await at('.mail-search-group .mail-search-all'));
    await page.until(`location.hash.startsWith('#/mail/l/s%3Asigned')`, 5000);
    await page.until(`!!document.querySelector('.sidebar .mail-search .mail-hit')`, 15000);
    check(`${tag}: "Open in Mail" shows the search in Mail`, (await page.eval<string>(`document.querySelector('.mail-search-box input').value`)) === 'signed');
    await click(await at(`.sidebar .mail-hit[data-thread="${lease.id}"]`));
    await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
    check(`${tag}: the results and the thread side by side`, (await inView('.sidebar .mail-search')) && (await inView('.center .mail-reader')) && (await has(`.sidebar .mail-hit.active[data-thread="${lease.id}"]`)));
    check(`${tag}: no sideways overflow: Mail's search`, !(await overflow()).length, await overflow());
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
