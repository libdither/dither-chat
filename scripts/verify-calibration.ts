/**
 * The calibration feed (docs/notifications.md, "The calibration feed"), end to end against a demo hub of its own in
 * headless Chromium. The demo (demo-calibration.ts) first fits the model with invented marks, then has a sound it
 * missed, a sound not wanted and a past answer back on the feed, and keeps to itself a silent mix-up, a notification
 * nothing you did says anything about, and a message only ever in the inbox. On a computer: the inbox row counts the
 * cards, the page is one column of cards, each with its cost; 1 answers the chosen card and draws the chances after,
 * w opens what it was wrong about, a part is kept with the answer, j and k move, x skips, a past answer is kept. On a
 * phone: one column, an answer, a swipe that skips and the toast's Undo, no sideways scroll, and the page before the
 * model is fitted.
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
  const r = await at(`${sel} .cal-n-b, ${sel} .cal-n-main`);
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
    return f.items.some((i) => i.kind === 'past') ? f : null;
  });
  check(v.fitted.signals >= v.fitted.need && v.fitted.need > 0, 'fitted from the marks given in place first', v.fitted);
  const kinds = new Set(v.items.map((i) => i.kind));
  const cards = v.items.filter((i) => i.kind === 'card');
  check(kinds.has('card') && kinds.has('past') && v.items.every((i) => i.kind === 'card' || i.kind === 'past'), 'only cards and a past answer, no rows', [...kinds]);
  check(cards.length >= 1 && cards.length <= 2, 'at most two cards a day', cards.length);
  const costs = new Set(cards.map((i) => i.cost));
  check(costs.has('missed') && costs.has('unwanted'), 'a sound missed and a sound not wanted', [...costs]);
  check(cards.every((i) => i.regret > 0.3 && i.you !== null), 'each card with its regret, from what you did', cards.map((i) => [i.regret, i.you]));
  check(v.items.every((i) => i.look !== 'row'), 'each one reached a device', v.items.map((i) => i.look));
  check(v.items.every((i, k) => k === 0 || v.items[k - 1].score >= i.score - 1e-9), 'most worth asking first');
  check(
    v.items.every((i) => Math.abs(i.p[0] + i.p[1] + i.p[2] - 1) < 0.01),
    'each item’s three chances add to one',
  );
  check(v.items.every((i) => i.parts.length === 6), 'six parts each');
  const waiting = await pending();
  check(waiting === v.items.length, 'the count is the cards and past answers', { waiting, items: v.items.length });

  // The whole feed on a phone, before anything is answered (a picture only; the phone is checked below).
  if (shots) {
    await p.size(412, 900, true);
    await p.goto(`${url}/?first#/calibration`);
    await p.until(`document.querySelectorAll('.cal-phone > .cal-card').length === ${v.items.length}`, 20_000);
    await shot('phone-feed');
  }

  // ---------------------------------------------------------------- a computer
  await p.size(1360, 900);
  await p.goto(`${url}/#/inbox`);
  await p.until(`!!document.querySelector('.calibration-row')`, 20_000);
  const count = await p.eval<string>(`document.querySelector('.calibration-row .requests-count')?.textContent ?? ''`);
  check(Number(count) === waiting, 'desktop: the inbox row counts what waits', count);
  await click('.calibration-row');
  await p.until(`location.hash === '#/calibration' && !!document.querySelector('.cal-wide .cal-card')`, 15_000);
  const desk = await p.eval<{ cards: number; rows: number; acts: number; did: number; cost: string[]; sel: string | null }>(`({
    cards: document.querySelectorAll('.cal-wide > .cal-card').length,
    rows: document.querySelectorAll('.cal-row, .cal-sure, .cal-mini').length,
    acts: document.querySelectorAll('.cal-wide .cal-card:first-of-type .cal-act').length,
    did: document.querySelectorAll('.cal-wide .cal-card:first-of-type .cal-did').length,
    cost: [...document.querySelectorAll('.cal-wide .cal-card')].map((c) => c.querySelector('.cal-cost')?.dataset.cost ?? ''),
    sel: document.querySelector('.cal-card.cal-sel')?.dataset.calId ?? null,
  })`);
  check(desk.cards === v.items.length && desk.rows === 0, 'desktop: one column of cards, no rows', desk);
  check(desk.acts === 3 && desk.did === 1, 'desktop: Sound, Show, Inbox, with what was done underlined', desk);
  check(desk.cost.filter(Boolean).length >= cards.length, 'desktop: each card shows its cost', desk.cost);
  check(desk.sel === v.items[0].id, 'desktop: the first chosen is the one most worth asking', { sel: desk.sel, top: v.items[0].id });
  await shot('desktop-feed');

  // 1 answers the chosen card: the bars become the chances after, over a dashed line at the old. A past answer takes
  // no new one, so choose a card first.
  const first = cards.find((i) => i.cost === 'missed')!.id;
  await click(`[data-cal-id="${first}"] .cal-n-t`);
  await p.until(`document.querySelector('.cal-card.cal-sel')?.dataset.calId === '${first}'`, 5_000);
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

  // j and k move the chosen card.
  const order = v.items.map((i) => i.id);
  await key('j');
  await p.until(`document.querySelector('.cal-card.cal-sel')?.dataset.calId === '${order[order.indexOf(first) + 1] ?? order[order.indexOf(first)]}'`, 5_000);
  check(true, 'desktop: j moves to the next');
  await key('k');
  await p.until(`document.querySelector('.cal-card.cal-sel')?.dataset.calId === '${order[Math.max(0, order.indexOf(first))]}'`, 5_000);
  check(true, 'desktop: k moves back');
  // x skips the chosen card: the other one, so the past answer below is still there.
  const skipped = cards.find((i) => i.id !== first)!.id;
  await click(`[data-cal-id="${skipped}"] .cal-n-t`);
  await p.until(`document.querySelector('.cal-card.cal-sel')?.dataset.calId === '${skipped}'`, 5_000);
  await key('x');
  await p.until(`!document.querySelector('[data-cal-id="${skipped}"]') && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Undo'))`, 5_000);
  const skippedOn = await until('the skip kept', async () => (db.query(`SELECT skipped FROM cal_item WHERE id = ?`).get(skipped) as { skipped: number }).skipped === 1, 5_000);
  check(skippedOn, 'desktop: x skips, with Undo on the toast');
  await noToasts();

  // A past answer: dashed, its answer chosen, Keep takes it off the page.
  const past = v.items.find((i) => i.kind === 'past')!;
  await p.until(`!!document.querySelector('.cal-card.cal-past[data-cal-id="${past.id}"]')`, 5_000);
  check(await p.eval(`!!document.querySelector('.cal-past [data-answer="${past.answer}"].cal-chosen') && document.querySelectorAll('.cal-past .cal-old').length === 3`), 'desktop: a past answer, with its guess before and after');
  await shot('desktop-past');
  await click(`[data-cal-id="${past.id}"] [data-settle="keep"]`);
  await p.until(`!document.querySelector('[data-cal-id="${past.id}"]')`, 5_000);
  check((db.query(`SELECT settled FROM cal_item WHERE id = ?`).get(past.id) as { settled: string }).settled === 'keep', 'desktop: Keep settles it');
  db.close();

  // Escape is back, as everywhere.
  await key('Escape');
  await p.until(`location.hash !== '#/calibration'`, 5_000);
  check(true, 'desktop: Escape goes back');

  // ---------------------------------------------------------------- a phone
  await p.size(412, 900, true);
  // The skipped card back, so the phone has two to work with.
  await fetch(`${url}/api/loudness/feed/${skipped}/skip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skip: false }) });
  // A page of its own (the desktop's skip is still in that one's memory).
  await p.goto(`${url}/?phone#/calibration`);
  await p.until(`!!document.querySelector('.cal-phone .cal-card')`, 20_000);
  const v2 = await feed();
  const ph = await p.eval<{ cards: number; rows: number; cost: number; wide: boolean }>(`({
    cards: document.querySelectorAll('.cal-phone > .cal-card').length,
    rows: document.querySelectorAll('.cal-row, .cal-sure').length,
    cost: document.querySelectorAll('.cal-phone .cal-cost').length,
    wide: document.documentElement.scrollWidth <= innerWidth + 1,
  })`);
  check(ph.cards === v2.items.length && ph.rows === 0 && ph.cost >= 1, 'phone: one column of cards, each with its cost', { ...ph, items: v2.items.length });
  check(ph.wide, 'phone: no sideways scroll');
  const card = v2.items.find((i) => i.kind === 'card' && !i.answer)!;
  await click(`[data-cal-id="${card.id}"] [data-answer="show"]`);
  await p.until(`!!document.querySelector('[data-cal-id="${card.id}"] .cal-acts.cal-answered')`, 10_000);
  check(true, 'phone: an answer draws the chances after');
  await p.eval(`document.querySelector('[data-cal-id="${card.id}"]').scrollIntoView({ block: 'start' })`);
  await shot('phone-answered');
  // A swipe of 150 px skips it; Undo brings it back.
  await drag(`[data-cal-id="${card.id}"]`, -150);
  await p.until(`!document.querySelector('[data-cal-id="${card.id}"]')`, 5_000);
  check(true, 'phone: a swipe skips');
  await click('.toast .toast-action');
  await p.until(`!!document.querySelector('[data-cal-id="${card.id}"]')`, 5_000);
  check(true, 'phone: Undo brings it back');
  // A short drag springs back.
  await drag(`[data-cal-id="${card.id}"]`, 40);
  await p.until(`(() => { const e = document.querySelector('[data-cal-id="${card.id}"]'); return !!e && !e.style.transform; })()`, 5_000);
  check(true, 'phone: a short drag springs back');
  await click(`[data-cal-id="${card.id}"] .cal-x`);
  await p.until(`!document.querySelector('[data-cal-id="${card.id}"]')`, 5_000);
  check(true, 'phone: × skips');
  await noToasts();

  // Before the model is fitted: nothing to ask, and how far along it is. The hub's side is in calfeed.test.ts; here
  // the page is shown the feed of a hub that has learned from 7 marks.
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/loudness/feed' }] });
  p.on('Fetch.requestPaused', (e) => {
    const body = Buffer.from(JSON.stringify({ items: [], fitted: { signals: 7, need: v.fitted.need } } satisfies P.CalFeedView)).toString('base64');
    void p.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body });
  });
  await p.goto(`${url}/?learning#/calibration`);
  await p.until(`!!document.querySelector('.calibration-pane .cal-fit')`, 10_000);
  const fit = await p.eval<string>(`document.querySelector('.cal-fit').getAttribute('aria-label')`);
  check(fit === `7 of ${v.fitted.need}`, 'phone: before it is fitted, how far along it is', fit);
  await p.eval(`document.querySelector('.cal-how').open = true`);
  await shot('phone-learning');
  await p.send('Fetch.disable');
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
