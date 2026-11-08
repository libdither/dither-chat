/**
 * Mail (docs/mail.md) in headless Chromium against a demo hub, whose fake mail account (hub demo.ts seedDemoMail) has
 * a reply thread with quoted text, a Cc'd thread, list mail, and an HTML-only message with a tracker and scripts. On a
 * phone (390x844, touch) and a desktop, in the dark and the light theme:
 *
 *   - no errors on the page, and nothing runs sideways off the screen;
 *   - the rail's Mail entry, the list, the views;
 *   - on a phone: the list, a thread over it, and back (the button and the browser's back);
 *   - the reader: the latest and unread messages open, the quote folded behind ···, read here after a second;
 *   - an HTML-only message shows its text part, and none of its script;
 *   - the Accounts screen's Mail group.
 *
 *   bun scripts/verify-mail.ts http://127.0.0.1:8700 [screenshot dir]
 * The hub must be a fresh demo hub (--demo) with its own data dir: reading marks threads read.
 */
import { mkdirSync } from 'node:fs';
import { launch, type Page } from './browser.ts';

const [base, shots] = process.argv.slice(2);
if (!base) throw new Error('usage: bun scripts/verify-mail.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
if (boot.mail?.access?.state !== 'granted') throw new Error('this demo hub has no mail');
const threads = ((await fetch(`${base}/api/mail/threads?list=v:inbox:*&limit=100`).then((r) => r.json())) as any).threads as any[];
const byTitle = (s: string) => threads.find((t) => t.subject.includes(s))!;
const dinner = byTitle('Dinner on Friday');
const shipped = byTitle('Your order has shipped');
const lease = byTitle('Lease renewal');
if (!dinner || !shipped || !lease) throw new Error('the demo mail is not as seeded');

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

const SIDEWAYS = '.level-picker, .ident-chips, .composer-files, .sheet-quick, pre, code, .log-view, .detail-dump, .lv-screen';
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
  check(`${tag}: rows are in the hub's order`, (await page.eval<string[]>(`[...document.querySelectorAll('.sidebar .mail-row')].map((r) => r.dataset.thread)`)).slice(0, 5).join() === threads.slice(0, 5).map((t) => t.id).join());
  check(`${tag}: no sideways overflow: list`, !(await overflow()).length, await overflow());
  await shot(`mail-${tag.replace(' ', '-')}-list`);

  // List, then the thread over it, then back.
  await tap(await at(`.sidebar .mail-row[data-thread="${dinner.id}"]`));
  await page.until(`!!document.querySelector('.mail-reader .mail-msg.open .mail-text')`, 15000);
  check(`${tag}: the thread opens as a card over the list`, (await hash()).includes(`/t/${dinner.id}`) && (await inView('.center .mail-reader')), await hash());
  const msgs = await page.eval<{ open: number; folded: number }>(`({ open: document.querySelectorAll('.mail-reader .mail-msg.open').length, folded: document.querySelectorAll('.mail-reader .mail-msg.folded').length })`);
  check(`${tag}: the latest and unread messages open, the read ones folded`, msgs.open === 1 && msgs.folded === 2, msgs);
  check(`${tag}: the quote is folded behind ···`, (await has('.mail-reader .mail-quote-toggle')) && !(await has('.mail-reader .mail-quote')));
  if (first) {
    await tap(await at('.mail-reader .mail-quote-toggle'));
    check(`${tag}: ··· shows the quote`, await page.eval(`(document.querySelector('.mail-reader .mail-quote')?.textContent ?? '').includes('Should I book a table')`));
    // Read here after a second in view.
    await Bun.sleep(1600);
    const t = ((await fetch(`${base}/api/mail/threads?list=v:inbox:*&limit=100`).then((r) => r.json())) as any).threads.find((x: any) => x.id === dinner.id);
    check(`${tag}: read here after a second in view`, t?.unread === 0, t?.unread);
  }
  check(`${tag}: no sideways overflow: reader`, !(await overflowThrough('.mail-reader-scroll')).length, await overflowThrough('.mail-reader-scroll'));
  await shot(`mail-${tag.replace(' ', '-')}-reader`);
  await tap(await at('.mail-reader .icon-btn.back'));
  await Bun.sleep(400);
  check(`${tag}: back goes to the list`, !(await hash()).includes('/t/') && (await inView('.sidebar .mail-list')), await hash());

  // The HTML-only message: its text part, none of its script.
  await tap(await at(`.sidebar .mail-row[data-thread="${shipped.id}"]`));
  await page.until(`(document.querySelector('.mail-reader .mail-text')?.textContent ?? '').length > 10`, 15000);
  const text = await page.eval<string>(`document.querySelector('.mail-reader .mail-text').textContent`);
  check(`${tag}: an HTML-only message shows its text part`, text.includes('your order #4471 has shipped') && text.includes('Track your parcel'), text.slice(0, 120));
  check(`${tag}: none of its script shows or runs`, !/alert|evil|hacked/.test(text) && !(await page.eval(`document.title.includes('hacked')`)));
  await page.eval('history.back()');
  await Bun.sleep(500);
  check(`${tag}: the browser's back goes to the list too`, !(await hash()).includes('/t/'), await hash());

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

try {
  await phone('dither-dark', true);
  await phone('dither-light', false);
  await desktop('dither-dark');
  await desktop('dither-light');
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
