/**
 * Notification calibration (docs/notifications.md, "Asking, without nagging"), end to end against a demo hub of its own
 * in headless Chromium: the inbox shows a quiet row with the count of questions waiting and no card anywhere else;
 * the page draws each notification again where it was seen (an Android phone's lock screen and shade, a laptop's
 * browser, an inbox row when none went out), says the line of where and when, and lists what is not known; an answer
 * takes the question off the page, lands on the hub and lowers the row's count. On a computer and on a phone.
 *
 *   bun scripts/verify-calibration.ts [--shots /tmp/shots]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
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

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
  stdout: 'ignore',
  stderr: 'inherit',
});
const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
/** Every picture's own images have loaded, so a screenshot shows what a person would see. */
const drawn = () => p.until(`[...document.images].every((i) => i.complete)`, 10_000);

try {
  await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok));
  // The demo world's questions (demo-calibration.ts) are seeded once its accounts have brought messages in.
  const list = await until('questions seeded', async () => {
    const l = (await (await fetch(`${url}/api/loudness/checkins`)).json()) as P.CheckinView[];
    return l.length >= 6 ? l : null;
  });
  check(list.some((c) => c.context.sent?.devices.some((d) => d.surface === 'lock')), 'a question seen on the lock screen');
  check(list.some((c) => !c.context.sent && c.context.notSent === 'watched'), 'a question about one never sent, the chat being watched');
  for (const desktop of [true, false]) {
    const tag = desktop ? 'desktop' : 'phone';
    await p.size(desktop ? 1360 : 412, desktop ? 900 : 900, !desktop);
    await p.goto(`${url}/#/inbox`);
    await p.until(`!!document.querySelector('.calibration-row')`, 20_000);
    const count = await p.eval<string>(`document.querySelector('.calibration-row .requests-count')?.textContent ?? ''`);
    check(Number(count) === list.length, `${tag}: the inbox row counts what waits`, count);
    check(!(await p.eval<boolean>(`!!document.querySelector('.loud-checkin, [data-fy-ask]')`)), `${tag}: no question card in the inbox`);
    if (shots && desktop) {
      await p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
      await p.shot(`${shots}/${tag}-inbox-row.png`);
    }
    await click('.calibration-row');
    await p.until(`location.hash === '#/calibration' && document.querySelectorAll('.calib-q').length > 0`, 15_000);
    const seen = await p.eval<{ q: number; android: number; lock: number; desktop: number; row: number; lines: number; unknown: number; tiles: number }>(`({
      q: document.querySelectorAll('.calib-q').length,
      android: document.querySelectorAll('[data-mock="android"]').length,
      lock: document.querySelectorAll('[data-mock="android"][data-surface="lock"]').length,
      desktop: document.querySelectorAll('[data-mock="desktop"]').length,
      row: document.querySelectorAll('[data-mock="row"]').length,
      lines: [...document.querySelectorAll('[data-summary]')].filter((e) => e.textContent.length > 10).length,
      unknown: document.querySelectorAll('.calib-unknown li').length,
      tiles: document.querySelectorAll('.calib-tile').length,
    })`);
    check(seen.q === list.length, `${tag}: every question is on the page`, seen);
    check(seen.android > 0 && seen.lock > 0 && seen.desktop > 0 && seen.row > 0, `${tag}: Android (lock screen too), desktop and inbox-row pictures drawn`, seen);
    check(seen.lines === seen.q, `${tag}: each says where, whether it sounded and when`);
    check(seen.unknown > 0, `${tag}: what is not known is said`);
    check(seen.tiles >= 5, `${tag}: the numbers are shown`);
    const wide = await p.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth + 1`);
    check(wide, `${tag}: no sideways scroll`);
    await drawn();
    if (shots) {
      // The demo's own notices raise toasts now and then: not part of this page, so out of its pictures.
      await p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove()); document.querySelector('.calib-scroll').scrollTop = 0`);
      await Bun.sleep(200);
      await p.shot(`${shots}/${tag}-page.png`);
      // The lock-screen one, whole.
      await p.eval(`document.querySelector('[data-surface="lock"]').closest('.calib-q').scrollIntoView({ block: 'start' })`);
      await Bun.sleep(200);
      await p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
      await p.shot(`${shots}/${tag}-lock-and-desktop.png`);
      await p.eval(`document.querySelector('[data-mock="row"]').closest('.calib-q').scrollIntoView({ block: 'start' })`);
      await Bun.sleep(200);
      await p.eval(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
      await p.shot(`${shots}/${tag}-inbox-row-mock.png`);
    }
    if (desktop) {
      // Answer the first sounded one: it leaves the page, the hub keeps the answer, the row's count goes down.
      const id = await p.eval<string>(`[...document.querySelectorAll('.calib-q[data-checkin="sounded"]')].find((q) => !q.querySelector('[data-surface="lock"]')).dataset.checkinId`);
      await click(`.calib-q[data-checkin-id="${id}"] [data-answer="worth"]`);
      await p.until(`!document.querySelector('[data-checkin-id="${id}"]')`, 10_000);
      const after = (await (await fetch(`${url}/api/loudness/checkins`)).json()) as P.CheckinView[];
      check(!after.some((c) => c.id === id) && after.length === list.length - 1, 'the answer took it off the hub’s list');
      const stats = (await (await fetch(`${url}/api/loudness/calibration`)).json()) as P.CalibrationStats;
      check(stats.answers.worth >= 1 && stats.pending === after.length, 'the numbers count it', { worth: stats.answers.worth, pending: stats.pending });
      list.splice(0, list.length, ...after);
      // A why may be asked after it: close it so the next pass starts clean.
      await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  }
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
