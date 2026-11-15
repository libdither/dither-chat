/**
 * The scorecard on How it sorts (packages/web/src/ui/Scorecard.tsx, docs/scorecard.md), in a real browser against a
 * demo hub, whose three invented weeks of scores (scorecard.ts seedDemoScores) give it something to draw:
 *
 *   - one chart per question, in SCORE_CHARTS' order, each with a line per metric that has a value and a legend that
 *     gives its last 7 days against the 7 before;
 *   - hovering a chart shows that day's value and how many it is of, for each line; the arrow keys move the day;
 *   - the table lists every day;
 *   - on a phone it fits: nothing wider than the screen;
 *   - in a light and a dark theme.
 *
 *   bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-scorecard.ts http://127.0.0.1:<port> [screenshot dir]
 */
import { mkdirSync } from 'node:fs';
import { SCORE_CHARTS } from '@dither-chat/protocol/scorecard';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-scorecard.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json() as Promise<any>);
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const scores = await fetch(`${base}/api/model/scores?days=60`).then((r) => r.json() as Promise<any>);
check('the hub answers with scored days', scores.days.length > 0, scores.days.length);

const { page, close } = await launch();
/** The app's own theme setting: its light or its dark theme (state.ts prefs). */
const scheme = (value: 'light' | 'dark') =>
  page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-${value}' }))`);

/** The demo world's toasts, out of the screenshots. */
const clearToasts = () => page.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

/** Open How it sorts and scroll to the scorecard; a shot of it if asked. */
const open = async (name?: string) => {
  // A load of its own each time, so a theme just set applies.
  await page.goto(`${base}/?load=${Date.now()}#/model`);
  await page.until(`!!document.querySelector('[data-scorecard] .sc-chart svg')`, 10_000);
  await page.eval(`document.querySelector('[data-scorecard]').scrollIntoView({ block: 'start' })`);
  await Bun.sleep(300);
  await clearToasts();
  if (shots && name) await page.shot(`${shots}/${name}.png`);
};

try {
  await page.size(1200, 900);
  await page.goto(`${base}/#/model`);
  await scheme('dark');
  await open('scorecard-dark');
  const charts = await page.eval<string[]>(`[...document.querySelectorAll('[data-scorecard] .sc-chart')].map((c) => c.dataset.chart)`);
  check('one chart per question, in order', JSON.stringify(charts) === JSON.stringify(SCORE_CHARTS.map((c) => c.id)), charts);
  const lines = await page.eval<number>(`[...document.querySelectorAll('[data-scorecard] .sc-line')].filter((p) => (p.getAttribute('d') || '').length > 10).length`);
  check('lines are drawn', lines >= 10, lines);
  const legend = await page.eval<string>(`document.querySelector('[data-chart="inbox-mrr"] .sc-legend').textContent`);
  check('the legend gives the last 7 days and the 7 before', /Mean 1 ÷ row 0\.\d\d \(was 0\.\d\d\)/.test(legend), legend);
  const dark = await page.eval<string>(`document.documentElement.dataset.theme`);
  check('a dark theme', dark === 'dark', dark);

  // Hover the notifications chart near its right end.
  const box = await page.eval<{ x: number; y: number; w: number; h: number }>(
    `(() => { const r = document.querySelector('[data-chart="notified"] svg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  );
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.w - 20, y: box.y + box.h / 2 });
  await Bun.sleep(200);
  const tip = await page.eval<string>(`document.querySelector('[data-chart="notified"] .sc-tip')?.textContent ?? ''`);
  check('hovering shows the day, each value and how many it is of', /Alerts\s*\d+%\s*of \d+/.test(tip) && /Conversations\s*\d+%\s*of \d+/.test(tip), tip);
  if (shots) {
    await page.eval(`document.querySelector('[data-chart="notified"]').scrollIntoView({ block: 'center' })`);
    await Bun.sleep(100);
    const b2 = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('[data-chart="notified"] svg').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b2.x + b2.w * 0.6, y: b2.y + b2.h / 2 });
    await Bun.sleep(200);
    await clearToasts();
    await page.shot(`${shots}/scorecard-hover.png`);
  }
  // The arrow keys move the day.
  const before = await page.eval<string>(`document.querySelector('[data-chart="notified"] .sc-tip-when')?.textContent ?? ''`);
  await page.eval(`document.querySelector('[data-chart="notified"] svg').focus()`);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await Bun.sleep(100);
  const after = await page.eval<string>(`document.querySelector('[data-chart="notified"] .sc-tip-when')?.textContent ?? ''`);
  check('the left arrow goes a day back', !!after && after !== before, { before, after });

  // The table.
  await page.eval(`document.querySelector('.sc-table summary').click()`);
  await Bun.sleep(100);
  const rows = await page.eval<number>(`document.querySelectorAll('.sc-table tbody tr').length`);
  check('the table lists every day', rows === scores.days.length, { rows, days: scores.days.length });

  await scheme('light');
  await Bun.sleep(300);
  await open('scorecard-light');
  const light = await page.eval<string>(`document.documentElement.dataset.theme`);
  check('a light theme', light === 'light', light);

  // A phone.
  await scheme('dark');
  await page.size(390, 844, true);
  await open('scorecard-phone');
  const wide = await page.eval<number>(`Math.max(...[...document.querySelectorAll('[data-scorecard] *')].filter((e) => !e.closest('.sc-table-scroll')).map((e) => e.getBoundingClientRect().right))`);
  check('on a phone nothing is wider than the screen', wide <= 390, wide);
  const errors = page.errors.filter((e) => !/favicon|ERR_ABORTED/.test(e));
  check('no errors on the page', errors.length === 0, errors);
} finally {
  await close();
}
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
