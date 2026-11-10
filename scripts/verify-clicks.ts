/**
 * Button counts (docs/button-counts.md) end to end against a demo hub in headless Chromium: off by default, nothing
 * is counted or sent; switched on in Settings → Usage, clicks on the inbox, the triage board, People, a chat's header
 * and composer, the rail, Ctrl+K and an untagged control reach the hub under their keys, by kind of device; the
 * table under the switch lists them; at phone size they count as phone; off again, nothing more is counted; Forget
 * empties it.
 *
 *   bun scripts/verify-clicks.ts http://127.0.0.1:8881 [/tmp/shots]
 * The hub must be a fresh demo hub with its own data dir: this changes its counts.
 */
import { mkdirSync } from 'node:fs';
import type { ClicksView } from '@dither-chat/protocol';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8881';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const totals = () => fetch(`${hub}/api/usage/clicks?days=7&by=device&limit=500`).then((r) => r.json()) as Promise<ClicksView>;
const byPage = () => fetch(`${hub}/api/usage/clicks?days=7&by=page&limit=500`).then((r) => r.json()) as Promise<ClicksView>;
const count = (v: ClicksView, key: string) => v.keys.find((k) => k.key === key);

const { page: p, close } = await launch();
async function click(selector: string, pick = 'el => true') {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(${pick}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${selector}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await Bun.sleep(250);
}
async function tap(selector: string) {
  const r = await p.eval<[number, number] | null>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!r) throw new Error(`nothing matches ${selector}`);
  const touch = (type: string, pts: [number, number][]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
  await touch('touchStart', [r]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
  await Bun.sleep(400);
}
/** The inbox's filter: its button, then a choice in its menu. */
async function pickFilter(label: string) {
  await click('.inbox-filter-btn');
  await p.until(`!!document.querySelector('.cm [role="menuitemradio"]')`, 3000);
  await click('.cm [role="menuitemradio"]', `el => el.innerText.trim() === '${label}'`);
}
const key = async (k: string, code: string, modifiers = 0) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers });
  await Bun.sleep(250);
};
/** What this device holds, not yet sent. */
const waiting = () => p.eval<number>(`(() => { const o = JSON.parse(localStorage.getItem('dither-chat:clicks-outbox') ?? 'null'); return (o?.tally?.length ?? 0) + (o?.batches?.length ?? 0); })()`);
/** Hides the page and shows it again: what the app does when put away, which sends the counts. */
const putAway = async () => {
  await p.eval(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete document.visibilityState; })()`);
  await Bun.sleep(800);
};

try {
  await p.size(1280, 900);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('.sidebar [data-row]').length > 3`, 20000);
  await Bun.sleep(600);

  // Off by default: clicking around counts nothing and sends nothing.
  check((await p.eval(`JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}').countClicks`)) === undefined, 'off on a new device');
  await pickFilter('Groups');
  await pickFilter('All');
  await putAway();
  check((await waiting()) === 0, 'off: nothing held on the device');
  check((await totals()).total === 0, 'off: nothing reached the hub');

  // Switched on in Settings → Usage.
  await click('.rail [data-track="settings"]');
  await p.until(`!!document.querySelector('#set-usage')`, 5000);
  check((await p.eval(`document.querySelector('#set-usage input[type=checkbox]').checked`)) === false, 'the switch starts off');
  await click('#set-usage input[type=checkbox]');
  check(await p.eval(`JSON.parse(localStorage.getItem('dither-chat:prefs')).countClicks === true`), 'switched on for this device');

  // The inbox: the filter, a section, a row, search; Ctrl+K.
  await click('.rail [data-track="inbox"]');
  await p.until(`document.querySelectorAll('.sidebar [data-row]').length > 3`, 5000);
  await pickFilter('Groups');
  await pickFilter('Groups');
  await pickFilter('All');
  await click('.sidebar [data-section="inbox-earlier"] .section-toggle');
  await click('.sidebar [data-section="inbox-earlier"] .section-toggle');
  const dmRow = await p.eval<string>(`document.querySelector('.sidebar [data-track^="row (DM"]')?.dataset.track ?? ''`);
  check(!!dmRow, 'an inbox row says its kind and state', dmRow);
  // On the row's text, not the button itself: still the row.
  await click('.sidebar [data-track^="row (DM"] .row-title');
  await p.until(`!!document.querySelector('.conv-head')`, 5000);
  await Bun.sleep(400);
  await click('.conv-head [data-track="details"]');
  await click('.conv-head [data-track="details"]');
  await click('.composer [data-track="text box"]');
  await key('k', 'KeyK', 2);
  await p.until(`!!document.querySelector('.switcher')`, 3000);
  await key('Escape', 'Escape');
  await click('.sidebar [data-track="search"]');

  // The triage board.
  await click('.rail [data-track="inbox"]');
  await p.until(`!!document.querySelector('.board')`, 5000);
  const card = await p.eval<boolean>(`!!document.querySelector('.board [data-track^="card"]')`);
  if (card) {
    await click('.board [data-track^="card"]');
    await click('.rail [data-track="inbox"]');
    await p.until(`!!document.querySelector('.board')`, 5000);
  }
  check(card, 'the board has cards to press');

  // People: a chip if there are any, a row.
  await click('.rail [data-track="people"]');
  await p.until(`!!document.querySelector('.sidebar [data-track^="row (person"]')`, 5000);
  await click('.sidebar [data-track^="row (person"]');
  await Bun.sleep(300);

  // Something with no key yet: a Settings switch other than ours.
  await click('.rail [data-track="settings"]');
  await p.until(`!!document.querySelector('#set-usage')`, 5000);
  await click('#set-calls .chip-btn');

  // Settings → Usage loads after sending what this device holds; its refresh sends what came since.
  await click('.settings-nav-item[data-track="settings: section Usage"]');
  await p.until(`document.querySelectorAll('#set-usage .clicks-table tbody tr').length > 5`, 8000);
  await click('#set-usage [aria-label="Count again"]');
  await p.until(`[...document.querySelectorAll('#set-usage .clicks-table td:first-child')].some((td) => td.textContent === 'settings: section Usage')`, 8000);
  const v = await totals();
  const want: [string, number][] = [
    ['inbox: filter', 3],
    ['inbox: filter (Groups)', 2],
    ['inbox: filter (All)', 1],
    ['inbox: section toggle (Earlier)', 2],
    [`inbox: ${dmRow}`, 1],
    ['chat header: details', 2],
    ['composer: text box', 1],
    ['keys: Ctrl+K (switcher)', 1],
    ['inbox: search', 1],
    ['rail: inbox', 3],
    ['rail: people', 1],
    ['rail: settings', 1],
    ['settings: other', 1],
    ['settings: section Usage', 1],
  ];
  for (const [k, n] of want) check((count(v, k)?.n ?? 0) >= n && count(v, k)?.desktop === count(v, k)?.n, `${k}: ${n}, on the desktop`, count(v, k));
  check(!!v.keys.find((k) => k.key.startsWith('people: row (person')), 'People: a row');
  if (card) check(!!v.keys.find((k) => k.key.startsWith('triage: card')), 'triage: a card');
  // Nothing before switching on: the first filter choices were not counted.
  check(count(v, 'inbox: filter (All)')?.n === 1, 'nothing from before it was switched on');
  // Keys and pages are fixed strings: no ids or names.
  const ids = new Set([...boot.conversations.map((c: any) => c.id), ...boot.persons.map((x: any) => x.id)]);
  const names = new Set([...boot.persons.map((x: any) => x.name), ...boot.conversations.map((c: any) => c.name).filter(Boolean)]);
  const pages = await byPage();
  check(pages.keys.every((k) => ![...ids, ...names].some((s) => k.key.includes(s) || (k.page ?? '').includes(s))), 'no id or name in any key or page', pages.keys.map((k) => `${k.key} @ ${k.page}`));
  check(pages.keys.some((k) => k.key === 'chat header: details' && k.page === 'conversation'), 'the page it was pressed on is kept');
  const rows = await p.eval<string[][]>(`[...document.querySelectorAll('#set-usage .clicks-table tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent))`);
  check(rows[0]?.[0] === v.keys[0].key, 'the table is sorted, most pressed first', rows.slice(0, 3));
  await p.eval(`document.querySelector('#set-usage').scrollIntoView({ block: 'start' })`);
  await Bun.sleep(300);
  if (shots) await p.shot(`${shots}/clicks-settings.png`);

  // At phone size the same clicks count as phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!document.querySelector('.tabbar')`, 10000);
  await Bun.sleep(600);
  await tap('.tabbar [data-track="tabs: Triage"]');
  await tap('.tabbar [data-track="tabs: Home"]');
  await tap('.sidebar [data-track^="row (DM"]');
  await p.until(`!!document.querySelector('.app.rest-open .conv-head [data-track="pager: back button"]')`, 5000);
  await Bun.sleep(400);
  await tap('.conv-head [data-track="pager: back button"]');
  await putAway();
  const phone = await totals();
  check(count(phone, 'tabs: Triage')?.phone === 1 && count(phone, 'tabs: Triage')?.desktop === 0, 'phone taps count as phone', count(phone, 'tabs: Triage'));
  check(count(phone, 'pager: back button')?.phone === 1, "the pager's back button, on the phone", count(phone, 'pager: back button'));

  // Off again: nothing more.
  await p.size(1280, 900);
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.querySelector('#set-usage input[type=checkbox]')`, 10000);
  await click('#set-usage input[type=checkbox]');
  check((await p.eval(`JSON.parse(localStorage.getItem('dither-chat:prefs')).countClicks`)) === false, 'switched off');
  const before = (await totals()).total;
  await click('.rail [data-track="inbox"]');
  await pickFilter('Groups');
  await pickFilter('All');
  await putAway();
  check((await waiting()) === 0 && (await totals()).total === before, 'off: nothing more counted or sent');

  // Forget empties the hub.
  await click('.rail [data-track="settings"]');
  await p.until(`!!document.querySelector('#set-usage .btn.danger')`, 5000);
  await p.eval(`window.confirm = () => true`);
  await click('#set-usage .btn.danger');
  await Bun.sleep(500);
  check((await totals()).total === 0, 'Forget deletes every count');
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} finally {
  await close();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
