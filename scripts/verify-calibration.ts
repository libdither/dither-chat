/**
 * The calibration feed (docs/notifications.md, "The calibration feed"), end to end against a demo hub of its own in
 * headless Chromium. The demo seeds every kind of item (demo-calibration.ts): cards in the shade, as a toast and as a
 * row, past answers back, rows, and the ones it was sure of. On a computer: the inbox row counts what waits and opens
 * the page in two panes; 1 answers and draws the chances after, w opens what it was wrong about, a part is kept with
 * the answer, j and k move, x skips, a past answer is kept. On a phone: one column, an answer, a row opened in place,
 * a swipe that skips and the toast's Undo, and no sideways scroll.
 *
 *   bun scripts/verify-calibration.ts [--shots /tmp/shots]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-calibration-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}
const feed = async () => (await (await fetch(`${url}/api/loudness/feed`)).json()) as P.CalFeedView;
const pending = async () => ((await (await fetch(`${url}/api/loudness/feed/count`)).json()) as { pending: number }).pending;

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
  stdout: 'ignore',
  stderr: 'inherit',
});
const { page: p, close } = await launch();
/** Where the first visible match is, scrolled into view. */
const at = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number; w: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  return r;
};
const click = async (sel: string) => {
  const r = await at(sel);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const key = async (k: string) => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k.length === 1 ? k : undefined, code: k.length === 1 ? `Key${k.toUpperCase()}` : k });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k });
};
/** A sideways drag on the card (from its text, not a button), `dx` px. */
const drag = async (sel: string, dx: number) => {
  const r = await at(`${sel} .cal-n-b, ${sel} .cal-row-main`);
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + (dx * i) / 8, y: r.y, button: 'left', buttons: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + dx, y: r.y, button: 'left', clickCount: 1 });
};
const noToasts = () => p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
/** Every picture's own images have loaded, so a screenshot shows what a person would see. */
const drawn = () => p.until(`[...document.images].every((i) => i.complete)`, 10_000);
const shot = async (name: string) => {
  if (!shots) return;
  await drawn().catch(() => {});
  await noToasts();
  await p.shot(`${shots}/${name}.png`);
};
/** The bars' fill heights on a card, in px. */
const fills = (id: string) => p.eval<number[]>(`[...document.querySelectorAll('[data-cal-id="${id}"] .cal-p')].map((e) => parseFloat(e.style.height))`);

try {
  await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok));
  // The demo world's feed (demo-calibration.ts) is seeded once its accounts have brought messages in.
  const v = await until('the feed seeded', async () => {
    const f = await feed();
    return f.items.some((i) => i.kind === 'past') && f.sure.length ? f : null;
  });
  const kinds = new Set(v.items.map((i) => i.kind));
  const looks = new Set(v.items.filter((i) => i.kind === 'card').map((i) => i.look));
  check(kinds.has('card') && kinds.has('row') && kinds.has('past') && v.sure.length > 0, 'every kind seeded: cards, rows, past answers, sure ones', [...kinds, `sure ${v.sure.length}`]);
  check(looks.has('shade') && looks.has('toast') && looks.has('row'), 'cards in the shade, as a toast and as a row', [...looks]);
  // The demo places its scenes as cards whatever their score; which ones the hub draws is in calfeed.test.ts.
  const top = v.items.filter((i) => i.kind === 'card' || i.kind === 'past');
  check(
    top.every((i) => i.chance > 0 && i.chance <= 1) && top.every((i, k) => k === 0 || top[k - 1].score >= i.score - 1e-9),
    'cards with the chance each was drawn with, most worth asking first',
  );
  check(v.items.slice(0, top.length).every((i) => i.kind === 'card' || i.kind === 'past'), 'cards and past answers before the rows');
  check(
    v.items.every((i) => Math.abs(i.p[0] + i.p[1] + i.p[2] - 1) < 0.01),
    'each item’s three chances add to one',
  );
  check(v.items.some((i) => i.you !== null) && v.items.some((i) => i.parts.length === 6), 'what you did, and six parts');
  const cards = v.items.filter((i) => i.kind === 'card' || i.kind === 'past').length;
  const waiting = await pending();
  check(waiting === cards, 'the count is the cards and past answers', { waiting, cards });

  // ---------------------------------------------------------------- a computer
  await p.size(1360, 900);
  await p.goto(`${url}/#/inbox`);
  await p.until(`!!document.querySelector('.calibration-row')`, 20_000);
  const count = await p.eval<string>(`document.querySelector('.calibration-row .requests-count')?.textContent ?? ''`);
  check(Number(count) === waiting, 'desktop: the inbox row counts what waits', count);
  await click('.calibration-row');
  await p.until(`location.hash === '#/calibration' && !!document.querySelector('.cal-desk .cal-main .cal-card')`, 15_000);
  const desk = await p.eval<{ side: number; main: number; acts: number; you: number; did: number; sure: string }>(`({
    side: document.querySelectorAll('.cal-side > .cal-row').length,
    main: document.querySelectorAll('.cal-main .cal-card').length,
    acts: document.querySelectorAll('.cal-main .cal-card .cal-act').length,
    you: document.querySelectorAll('.cal-main .cal-card .cal-you').length,
    did: document.querySelectorAll('.cal-main .cal-card .cal-did').length,
    sure: document.querySelector('.cal-sure summary')?.textContent ?? '',
  })`);
  check(desk.side === v.items.length && desk.main === 1, 'desktop: every item a row on the left, one open on the right', desk);
  check(desk.acts === 3 && desk.did === 1, 'desktop: Sound, Show, Inbox, with what it did underlined', desk);
  check(desk.sure.includes(`${v.sure.length} it was sure of`), 'desktop: the sure ones folded', desk.sure);
  await shot('desktop-feed');

  // The one open first is the one most worth asking, a card or a past answer (both are sorted by worth asking now).
  const opened = await p.eval<string>(`document.querySelector('.cal-main .cal-card').dataset.calId`);
  check(opened === v.items[0].id, 'desktop: the first open is the one most worth asking', { opened, top: v.items[0].id });
  // 1 answers the one open: the bars become the chances after, over a dashed line at the old. A past answer takes
  // no new one, so open a card from its row on the left first.
  const first = v.items.find((i) => i.kind === 'card')!.id;
  await click(`.cal-side [data-cal-id="${first}"]`);
  await p.until(`document.querySelector('.cal-main .cal-card')?.dataset.calId === '${first}'`, 5_000);
  const before = await fills(first);
  await key('1');
  await p.until(`!!document.querySelector('[data-cal-id="${first}"] .cal-acts.cal-answered') && document.querySelectorAll('[data-cal-id="${first}"] .cal-old').length === 3`, 10_000);
  check(await p.eval(`!!document.querySelector('[data-cal-id="${first}"] [data-answer="sound"].cal-chosen')`), 'desktop: 1 answered Sound');
  const afterAnswer = await fills(first);
  check(afterAnswer[0] > before[0], 'desktop: Sound’s chance is higher after', { before, after: afterAnswer });
  check(await p.eval(`!!document.querySelector('[data-cal-id="${first}"] .cal-drill[open]')`), 'desktop: what it was wrong about opens');
  await until('the count to go down', async () => ((await pending()) === waiting - 1 ? true : null), 10_000);
  check(true, 'desktop: the hub took the answer');
  // w closes it and opens it again.
  await key('w');
  await p.until(`!document.querySelector('[data-cal-id="${first}"] .cal-drill[open]')`, 5_000);
  await key('w');
  await p.until(`!!document.querySelector('[data-cal-id="${first}"] .cal-drill[open]')`, 5_000);
  check(true, 'desktop: w closes and opens what it was wrong about');
  const parts = await p.eval<number>(`document.querySelectorAll('[data-cal-id="${first}"] .cal-part').length`);
  check(parts === 6, 'desktop: six parts', parts);
  await click(`[data-cal-id="${first}"] [data-part="chat"]`);
  await p.until(`!!document.querySelector('[data-cal-id="${first}"] [data-part="chat"].cal-on')`, 5_000);
  const db = new Database(join(data, 'hub.sqlite'), { readonly: true });
  const kept = await until(
    'the part kept',
    async () => (db.query(`SELECT a.parts FROM attn_answer a JOIN cal_item f ON f.answer_id = a.id WHERE f.id = ?`).get(first) as { parts: string | null } | null)?.parts,
    10_000,
  );
  check(JSON.parse(kept).includes('chat'), 'desktop: the part is kept with the answer', kept);
  await shot('desktop-answered');

  // j and k move; x skips the one open.
  await key('j');
  await p.until(`document.querySelector('.cal-main .cal-card')?.dataset.calId !== '${first}'`, 5_000);
  const second = await p.eval<string>(`document.querySelector('.cal-main .cal-card').dataset.calId`);
  check(await p.eval(`document.querySelector('.cal-side .cal-sel')?.dataset.calId === '${second}'`), 'desktop: j moves to the next, marked on the left');
  await key('k');
  await p.until(`document.querySelector('.cal-main .cal-card')?.dataset.calId === '${first}'`, 5_000);
  check(true, 'desktop: k moves back');
  // x skips the one open: another card, so the past answer below is still there.
  const skipped = v.items.find((i) => i.kind === 'card' && i.id !== first)!.id;
  await click(`.cal-side [data-cal-id="${skipped}"]`);
  await p.until(`document.querySelector('.cal-main .cal-card')?.dataset.calId === '${skipped}'`, 5_000);
  await key('x');
  await p.until(`!document.querySelector('.cal-side [data-cal-id="${skipped}"]') && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Undo'))`, 5_000);
  const skippedOn = await until('the skip kept', async () => (db.query(`SELECT skipped FROM cal_item WHERE id = ?`).get(skipped) as { skipped: number }).skipped === 1, 5_000);
  check(skippedOn, 'desktop: x skips, with Undo on the toast');
  await noToasts();

  // A past answer: dashed, its answer chosen, Keep takes it off the page.
  const past = v.items.find((i) => i.kind === 'past')!;
  await click(`.cal-side [data-cal-id="${past.id}"]`);
  await p.until(`!!document.querySelector('.cal-main .cal-card.cal-past[data-cal-id="${past.id}"]')`, 5_000);
  check(await p.eval(`!!document.querySelector('.cal-main .cal-past [data-answer="${past.answer}"].cal-chosen') && document.querySelectorAll('.cal-main .cal-past .cal-old').length === 3`), 'desktop: a past answer, with its guess before and after');
  await shot('desktop-past');
  await click(`.cal-main [data-settle="keep"]`);
  await p.until(`!document.querySelector('[data-cal-id="${past.id}"]')`, 5_000);
  check((db.query(`SELECT settled FROM cal_item WHERE id = ?`).get(past.id) as { settled: string }).settled === 'keep', 'desktop: Keep settles it');
  db.close();

  // Escape is back, as everywhere.
  await key('Escape');
  await p.until(`location.hash !== '#/calibration'`, 5_000);
  check(true, 'desktop: Escape goes back');

  // ---------------------------------------------------------------- a phone
  await p.size(412, 900, true);
  await p.goto(`${url}/#/calibration`);
  await p.until(`!!document.querySelector('.cal-phone .cal-card')`, 20_000);
  const v2 = await feed();
  const ph = await p.eval<{ cards: number; rows: number; shade: number; toast: number; row: number; wide: boolean }>(`({
    cards: document.querySelectorAll('.cal-phone > .cal-card').length,
    rows: document.querySelectorAll('.cal-phone > .cal-row').length,
    shade: document.querySelectorAll('.cal-phone [data-look="shade"]').length,
    toast: document.querySelectorAll('.cal-phone [data-look="toast"]').length,
    row: document.querySelectorAll('.cal-phone [data-look="row"]').length,
    wide: document.documentElement.scrollWidth <= innerWidth + 1,
  })`);
  const want = v2.items.filter((i) => i.kind !== 'row').length;
  check(ph.cards === want && ph.rows === v2.items.length - want, 'phone: cards, then rows', { ...ph, want });
  check(ph.shade > 0 && ph.toast > 0 && ph.row > 0, 'phone: each look drawn', ph);
  check(ph.wide, 'phone: no sideways scroll');
  await p.eval(`document.querySelector('.cal-scroll').scrollTop = 0`);
  await shot('phone-feed');
  const card = v2.items.find((i) => i.kind === 'card')!;
  await click(`[data-cal-id="${card.id}"] [data-answer="show"]`);
  await p.until(`!!document.querySelector('[data-cal-id="${card.id}"] .cal-acts.cal-answered')`, 10_000);
  check(true, 'phone: an answer draws the chances after');
  await p.eval(`document.querySelector('[data-cal-id="${card.id}"]').scrollIntoView({ block: 'start' })`);
  await shot('phone-answered');
  // A row opens in place as a card.
  const row = v2.items.find((i) => i.kind === 'row')!;
  await click(`.cal-row[data-cal-id="${row.id}"] .cal-row-main`);
  await p.until(`!!document.querySelector('.cal-card[data-cal-id="${row.id}"]')`, 5_000);
  check(true, 'phone: a row opens in place');
  // A swipe of 150 px skips it; Undo brings it back.
  const swiped = v2.items.find((i) => i.kind === 'card' && i.id !== card.id) ?? row;
  await drag(`[data-cal-id="${swiped.id}"]`, -150);
  await p.until(`!document.querySelector('[data-cal-id="${swiped.id}"]')`, 5_000);
  check(true, 'phone: a swipe skips');
  await click('.toast .toast-action');
  await p.until(`!!document.querySelector('[data-cal-id="${swiped.id}"]')`, 5_000);
  check(true, 'phone: Undo brings it back');
  // A short drag springs back.
  await drag(`[data-cal-id="${swiped.id}"]`, 40);
  await Bun.sleep(300);
  check(await p.eval(`!!document.querySelector('[data-cal-id="${swiped.id}"]')`), 'phone: a short drag springs back');
  await click(`[data-cal-id="${swiped.id}"] .cal-x`);
  await p.until(`!document.querySelector('[data-cal-id="${swiped.id}"]')`, 5_000);
  check(true, 'phone: × skips');
  await p.eval(`document.querySelector('.cal-sure').open = true; document.querySelector('.cal-how').open = true; document.querySelector('.cal-how').scrollIntoView({ block: 'end' })`);
  await shot('phone-sure-and-how');
  if (p.errors.length) check(false, 'no page errors', p.errors);
} catch (e) {
  failed++;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
