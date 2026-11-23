/**
 * One inbox row per channel for its threads (docs/inbox.md "One row per channel"), end to end in headless Chromium
 * against a demo hub with the Zulip organization (hub/src/demo-zulip.ts):
 *
 * - Computer: the design channel is one row, keyed `channel:<id>`, with no row of its own for the topic that mentions
 *   you; it shows that topic's name and message, the channel's unread summed over its topics, and the red @ count. A
 *   Discord thread folds into its text channel's row the same way.
 * - The chevron opens the row in place (the page stays where it was) on its unread topics, the one that mentions you
 *   first, then the latest; it stays open after a reload. A topic under it opens that topic, and the row stays the
 *   active one. The row itself opens the channel.
 * - Phone: the Home tab is the same list, with the same row, closed and open.
 * - Mark As Read on the row's menu reads every topic of the channel, with no confirm.
 *
 *   DITHER_DEMO_SCENARIO=zulip bun run hub -- --demo --data <temp dir> --port <port>
 *   bun scripts/verify-channel-rows.ts http://127.0.0.1:PORT [/tmp/shots]
 *
 * The hub must be a fresh demo hub with its own data dir: this marks the channel read.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8491';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

const host = 'chat.example.org';
const conv = (pick: (c: any) => boolean, what: string) => {
  const c = boot.conversations.find(pick);
  if (!c) throw new Error(`no ${what}: start the hub with DITHER_DEMO_SCENARIO=zulip`);
  return c;
};
const design = conv((c) => c.network === 'zulip' && c.nativeId === `${host}/s/10`, 'design channel');
const topic = (name: string) => conv((c) => c.network === 'zulip' && c.parentId === design.id && c.name === name, `topic ${name}`);
const tokens = topic('Color tokens');
const buttons = topic('Button states');
const spacing = topic('Spacing scale');
const dht = conv((c) => c.network === 'discord' && c.shape === 'thread' && c.name === 'DHT bootstrap refactor', 'Discord thread');
const row = `channel:${design.id}`;
const rowSel = `[data-row="${row}"]`;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const dialogs: string[] = [];
p.on('Page.javascriptDialogOpening', (e) => {
  dialogs.push(e.message);
  void p.send('Page.handleJavaScriptDialog', { accept: true });
});
const mouse = (type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none') =>
  p.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
let phone = false;
const click = async ([x, y]: [number, number], button: 'left' | 'right' = 'left') => {
  if (phone && button === 'left') {
    await touch('touchStart', [[x, y]]);
    await touch('touchEnd', []);
    return;
  }
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button);
  await mouse('mouseReleased', x, y, button);
};
const at = async (sel: string, text = ''): Promise<[number, number]> => {
  const r = await p.eval<[number, number] | null>(
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.getBoundingClientRect().width > 0 && e.textContent.includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${text}`);
  return r;
};
const text = (sel: string) => p.eval<string | null>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const subRows = () => p.eval<string[]>(`[...document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow .inbox-subrow-name')].map((e) => e.textContent)`);
const hash = () => p.eval<string>('location.hash');
const shot = async (name: string) => {
  if (!shots) return;
  await p.eval(`document.querySelector(${JSON.stringify(rowSel)})?.scrollIntoView({ block: 'center' })`);
  await Bun.sleep(400);
  await p.shot(`${shots}/${name}.png`);
};

try {
  // ---------------------------------------------------------------- computer
  await p.size(1280, 800);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector(${JSON.stringify(rowSel)})`, 15000);
  check(!(await p.eval<boolean>(`!!document.querySelector('[data-row="${tokens.id}"]')`)), 'the topic that mentions you has no row of its own');
  check(await p.eval<boolean>(`!!document.querySelector('[data-row="channel:${dht.parentId}"]') && !document.querySelector('[data-row="${dht.id}"]')`), "a Discord thread folds into its channel's row");
  check((await text(`${rowSel} .row-title`))?.includes('design'), "the row is the channel's", await text(`${rowSel} .row-title`));
  check((await text(`${rowSel} .row-subject`)) === 'Color tokens', "its preview is the latest listed topic's", await text(`${rowSel} .row-subject`));
  // Color tokens 2, Button states 2, Spacing scale 1: every unread topic of the channel, listed or not.
  check((await text(`${rowSel} .count.muted`)) === '5', 'the unread is summed over its topics', await text(`${rowSel} .count.muted`));
  check((await text(`${rowSel} .row-at`)) === '@1', 'the red @ count says a topic mentions you', await text(`${rowSel} .row-at`));
  const fold = `[data-row-key="${row}"] .row-fold`;
  check((await p.eval<string>(`document.querySelector(${JSON.stringify(fold)})?.getAttribute('aria-expanded')`)) === 'false', 'it starts closed');
  check((await subRows()).length === 0, 'closed, it lists no topics');
  await shot('computer-closed');

  const before = await hash();
  await click(await at(fold));
  await p.until(`document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow').length > 0`, 5000);
  check(JSON.stringify(await subRows()) === JSON.stringify(['Color tokens', 'Button states', 'Spacing scale']), 'open, it lists its unread topics: the one that mentions you first, then the latest', await subRows());
  check((await hash()) === before, 'the chevron opens it in place, not the channel');
  await shot('computer-open');

  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow').length > 0`, 15000);
  check(true, 'it is still open after a reload (kept on this device)');

  // ---------------------------------------------------------------- phone
  phone = true;
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector('.app.phone') && !!document.querySelector(${JSON.stringify(rowSel)})`, 15000);
  check(JSON.stringify(await subRows()) === JSON.stringify(['Color tokens', 'Button states', 'Spacing scale']), 'phone: the Home tab has the same row, open as this device left it', await subRows());
  await shot('phone-open');
  await click(await at(fold));
  await p.until(`document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow').length === 0`, 5000);
  check(true, 'phone: a tap on the chevron closes it');
  await shot('phone-closed');
  await click(await at(fold));
  await p.until(`document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow').length > 0`, 5000);
  phone = false;
  await p.size(1280, 800);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('[data-row-key="${row}"] .inbox-subrow').length > 0`, 15000);

  await click(await at(`[data-row-key="${row}"] .inbox-subrow`, 'Button states'));
  await p.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(buttons.id))}) || location.hash.includes(${JSON.stringify(buttons.id)})`, 5000);
  check(true, 'a topic under the row opens that topic');
  await p.until(`document.querySelector(${JSON.stringify(rowSel)})?.classList.contains('active')`, 5000);
  check(await p.eval<boolean>(`!!document.querySelector('[data-row-key="${row}"] .inbox-subrow.active')`), 'the row stays the active one, and the topic under it is marked open');
  await shot('computer-topic-open');

  await click(await at(rowSel));
  await p.until(`location.hash.includes(${JSON.stringify(encodeURIComponent(design.id))}) || location.hash.includes(${JSON.stringify(design.id)})`, 5000);
  await p.until(`!!document.querySelector('.forum-post')`, 8000);
  check(true, 'the row opens the channel');

  // ---------------------------------------------------------------- mark read
  await p.size(1280, 800);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector(${JSON.stringify(rowSel)})`, 15000);
  await click(await at(rowSel), 'right');
  await p.until(`[...document.querySelectorAll('.cm .cm-item')].some((e) => e.textContent.includes('Mark As Read'))`, 5000);
  await click(await at('.cm .cm-item', 'Mark As Read'));
  const read = async () => {
    const b = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
    return [tokens, buttons, spacing].every((t) => b.conversations.find((c: any) => c.id === t.id)?.vantages.every((v: any) => !v.unread && !v.mentions));
  };
  const end = Date.now() + 8000;
  while (!(await read()) && Date.now() < end) await Bun.sleep(250);
  check(await read(), 'Mark As Read on the row reads every topic of the channel');
  check(dialogs.length === 0, 'with no confirm', dialogs);
} catch (e) {
  check(false, (e as Error).message);
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
