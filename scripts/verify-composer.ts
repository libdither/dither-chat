/**
 * The composer's size (docs/phone.md, "Keyboard"), in a real browser against a demo hub of its own on a fresh data dir.
 * As Discord's: it grows with the text up to about five lines on a phone, never more than 40% of what is visible,
 * scrolls inside past that, shrinks as text is deleted and to one line after a send, and never pushes the timeline or
 * the header off screen, with the keyboard up or not. Typed, pasted, restored from a draft, and with files attached.
 * The desktop keeps its ten lines.
 *
 *   bun scripts/verify-composer.ts [--port 8690] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. Headless Chromium has no keyboard: its effect is imitated by
 * shrinking the layout (Android) and by faking a smaller visual viewport (iOS), as verify-phone.ts does.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8690'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-composer-${PORT}-`));
mkdirSync(work, { recursive: true });
const shots = opt('shots', '');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
const hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', join(work, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
  env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
  stdout: log,
  stderr: log,
});
await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
const boot = (await fetch(`${base}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// A Discord channel with more than one account in it: the send-as chip makes its box the narrowest there is.
const conv = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'dev');
if (!conv) throw new Error('no #dev in the demo');

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a long message`).join('\n');

const { page, close } = await launch();
/** The box, the timeline, the header and the send button, as laid out now. */
const measure = () =>
  page.eval<{ ta: number; inline: string; scrolls: boolean; line: number; pad: number; vis: number; tl: number; headTop: number; sendBottom: number; composerBottom: number }>(`(() => {
    const t = document.querySelector('.composer textarea');
    const vis = window.visualViewport ? Math.min(innerHeight, visualViewport.height) : innerHeight;
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    return {
      ta: Math.round(t.getBoundingClientRect().height),
      inline: t.style.height,
      scrolls: t.scrollHeight > t.clientHeight + 1,
      line: parseFloat(getComputedStyle(t).lineHeight),
      pad: parseFloat(getComputedStyle(t).paddingTop) + parseFloat(getComputedStyle(t).paddingBottom),
      vis: Math.round(vis),
      tl: Math.round(r('.timeline-scroll')?.height ?? -1),
      headTop: Math.round(r('.conv-head')?.top ?? -1),
      sendBottom: Math.round(r('.composer .send-btn').bottom),
      composerBottom: Math.round(r('.composer').bottom),
    };
  })()`);
const setText = async (text: string) => {
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.select(); })()`);
  if (text) await page.send('Input.insertText', { text });
  else await page.eval(`document.execCommand('delete')`);
  await Bun.sleep(120);
};
/** Lines the box shows, from its height less its padding. */
const linesOf = (m: { ta: number; line: number; pad: number }) => Math.round(((m.ta - m.pad) / m.line) * 10) / 10;
/** What every state must keep: header at the top, the timeline in sight, the composer and its send button on screen. */
const inSight = (name: string, m: Awaited<ReturnType<typeof measure>>, minTimeline = 60) =>
  check(`${name}: header, timeline and send button stay on screen`, m.headTop >= 0 && m.tl >= minTimeline && m.sendBottom <= m.vis + 1 && m.composerBottom <= m.vis + 1, m);
const phoneSize = (h: number, w = 390) => page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });

try {
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/${conv.id}`);
  await page.until(`!!document.querySelector('.app.phone .composer textarea')`, 20000);
  await Bun.sleep(700);

  // ------------------------------------------------------------------ a phone, keyboard down

  let m = await measure();
  check('opening a chat measures nothing: no height set on the box', m.inline === '', m.inline);
  check('empty: one line', linesOf(m) <= 1.1, m);
  const one = m.ta;
  await setText('hello');
  m = await measure();
  check('a word: still one line', m.ta === one, m);
  await setText('one\ntwo\nthree');
  m = await measure();
  check('three lines: it grows to three', Math.abs(linesOf(m) - 3) < 0.3 && !m.scrolls, m);
  await setText(LINES);
  m = await measure();
  check('thirty lines pasted: capped at five lines, and it scrolls inside', Math.abs(linesOf(m) - 5) < 0.3 && m.scrolls, m);
  inSight('thirty lines', m, 300);
  if (shots) await page.shot(join(shots, 'composer-cap.png'));
  await page.send('Input.insertText', { text: ' and more' });
  await Bun.sleep(150);
  const end = await page.eval<{ top: number; client: number; height: number }>(`(() => { const t = document.querySelector('.composer textarea'); return { top: Math.round(t.scrollTop), client: t.clientHeight, height: t.scrollHeight }; })()`);
  // The caret's line is in sight; the padding under it may not be.
  check('typing at the end of a long draft keeps the caret in sight', end.top + end.client >= end.height - 14, end);

  // ------------------------------------------------------------------ the keyboard up

  await phoneSize(480);
  await Bun.sleep(300);
  m = await measure();
  check('keyboard up (Android, layout 480 high): still five lines at most', linesOf(m) <= 5.1 && m.ta <= 0.4 * 480 + 1, m);
  inSight('keyboard up', m, 150);
  if (shots) await page.shot(join(shots, 'composer-cap-keyboard.png'));
  await phoneSize(330, 360);
  await Bun.sleep(300);
  m = await measure();
  check('a small phone with the keyboard up (330 high): no more than 40% of it', m.ta <= 0.4 * 330 + 1, m);
  inSight('a small phone with the keyboard up', m, 60);
  await phoneSize(844);
  await Bun.sleep(300);
  // iOS: only the visual viewport shrinks; phone.ts sizes the app to it.
  await page.eval(`(() => {
    document.querySelector('.composer textarea').focus();
    Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 300 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 0 });
    visualViewport.dispatchEvent(new Event('resize'));
  })()`);
  await Bun.sleep(300);
  m = await measure();
  check('iOS keyboard (visual viewport 300 high): no more than 40% of it', m.vis === 300 && m.ta <= 0.4 * 300 + 1, m);
  inSight('iOS keyboard', m, 40);
  await page.eval(`(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); })()`);
  await Bun.sleep(300);

  // ------------------------------------------------------------------ shrinking, sending

  await setText('one\ntwo');
  m = await measure();
  check('deleted back to two lines: it shrinks to two', Math.abs(linesOf(m) - 2) < 0.3, m);
  await setText('');
  m = await measure();
  check('emptied: one line again', m.ta === one, m);
  const text = `${LINES}\nsent ${Date.now().toString(36)}`;
  await setText(text);
  await page.eval(`document.querySelector('.composer .send-btn').click()`);
  await Bun.sleep(300);
  m = await measure();
  check('sent: one line again', m.ta === one && (await page.eval<string>(`document.querySelector('.composer textarea').value`)) === '', m);
  await until(async () => ((await fetch(`${base}/api/conversations/${conv.id}/messages?limit=10`).then((r) => r.json())) as any).messages.some((x: any) => x.body === text), 10_000, 'the message on the hub').then(
    () => check('…and the message went', true),
    () => check('…and the message went', false),
  );

  // ------------------------------------------------------------------ files and a reply above it

  await page.eval(`(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 64; c.getContext('2d').fillRect(0, 0, 32, 32);
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    for (const n of ['a.png', 'b.png', 'c.png']) dt.items.add(new File([b], n, { type: 'image/png' }));
    const i = document.querySelector('.composer input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.until(`document.querySelectorAll('.composer-file').length === 3`, 5000);
  await setText(LINES);
  await phoneSize(480);
  await Bun.sleep(300);
  m = await measure();
  inSight('three files and a long draft, keyboard up', m, 80);
  for (const b of await page.eval<number>(`document.querySelectorAll('.composer-file button[aria-label^="Remove"], .composer-file button[aria-label^="Cancel"]').length`).then((n) => Array.from({ length: n }))) {
    void b;
    await page.eval(`document.querySelector('.composer-file button[aria-label^="Remove"], .composer-file button[aria-label^="Cancel"]')?.click()`);
    await Bun.sleep(50);
  }
  await phoneSize(844);
  await Bun.sleep(200);

  // ------------------------------------------------------------------ a long draft restored, and Catch up's box

  // The draft is shared with Catch up's reply box and kept across a reload.
  await page.eval(`location.reload()`);
  await page.until(`!!document.querySelector('.app.phone .composer textarea')`, 20000);
  await Bun.sleep(800);
  m = await measure();
  check('a long draft restored on a reload: five lines, no more', (await page.eval<string>(`document.querySelector('.composer textarea').value`)) === LINES && Math.abs(linesOf(m) - 5) < 0.3, m);
  inSight('restored draft', m, 300);
  // The emoji list over a box at its cap, keyboard up, stays on screen.
  await phoneSize(480);
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await page.send('Input.insertText', { text: ' :smi' });
  await page.until(`!!document.querySelector('.ec-pop')`, 5000).catch(() => {});
  const pop = await page.eval<{ top: number; bottom: number } | null>(`(() => { const r = document.querySelector('.ec-pop')?.getBoundingClientRect(); return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null; })()`);
  check('the emoji list over a full box, keyboard up, stays on screen', !!pop && pop.top >= 0, pop);
  await setText('');
  await phoneSize(844);
  await Bun.sleep(200);

  // ------------------------------------------------------------------ the desktop keeps its ten lines

  await page.size(1280, 800);
  await Bun.sleep(400);
  await setText(LINES);
  m = await measure();
  check('desktop: capped at 220px, as before', m.ta === 220 && m.scrolls, m);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 400, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(300);
  m = await measure();
  check('a short desktop window (400 high): no more than 40% of it', m.ta <= 160 + 1, m);
  await setText('');
  m = await measure();
  check('desktop, emptied: one line', linesOf(m) <= 1.1, m);

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
