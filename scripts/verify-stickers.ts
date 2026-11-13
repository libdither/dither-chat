/**
 * Discord stickers, its newer system lines, and the composer's emoji button, in a real browser against a demo hub of
 * its own on a fresh data dir. The demo's DM with Jordan holds a friend request accepted (message type 67), a picture
 * sticker and a Lottie one, as the extractor maps them (dither-accounts, extractors/discord/src/map.ts).
 *
 *   bun scripts/verify-stickers.ts [--port 8694] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Checks: the system line reads as words; a picture sticker shows at 160 px with no frame; a Lottie sticker plays as an
 * SVG; the emoji button opens the picker for writing (no reaction parts), puts a Unicode emoji and a server's custom
 * one (as <:name:id>) into the box at the caret, closes after a pick and stays open with Shift; on a phone it opens
 * as a sheet and leaves the keyboard down.
 */
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8694'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-stickers-${PORT}-`));
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
const jordan = boot.persons.find((p: any) => p.name === 'Jordan');
const dm = boot.conversations.find((c: any) => c.network === 'discord' && c.shape === 'direct' && c.peerPersonId === jordan?.id);
const dev = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'dev');
if (!dm || !dev) throw new Error('no DM with Jordan or no #dev in the demo');

const { page, close } = await launch();
const value = () => page.eval<string>(`document.querySelector('.composer textarea').value`);
const pickerOpen = () => page.eval<boolean>(`!!document.querySelector('.emoji-picker')`);
/** Clicks the picker's emoji named `name` (its :shortcode:), with Shift when asked. */
const pickEmoji = (name: string, shift = false) =>
  page.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll('.emoji-picker .ep-emoji')].find((x) => x.getAttribute('aria-label') === ${JSON.stringify(name)});
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shift} }));
    return true;
  })()`);

try {
  // ------------------------------------------------------------------ stickers and the friend line, desktop
  await page.size(1280, 860);
  await page.goto(`${base}/#/c/${dm.id}`);
  await page.until(`!!document.querySelector('.composer textarea')`, 20000);
  await page.until(`[...document.querySelectorAll('.msg')].some((m) => m.textContent.includes('accepted your friend request'))`, 10000).catch(() => {});
  const lines = await page.eval<string[]>(`[...document.querySelectorAll('.msg')].map((m) => m.textContent)`);
  check('message type 67 reads as words', lines.some((t) => t.includes('Jordan accepted your friend request.')) && !lines.some((t) => t.includes('unsupported message type')));

  await page.until(`(() => { const i = document.querySelector('img.sticker'); return !!i && i.complete && i.naturalWidth > 0; })()`, 10000).catch(() => {});
  const pic = await page.eval<{ w: number; h: number; loaded: boolean; framed: boolean; alt: string } | null>(`(() => {
    const i = document.querySelector('img.sticker');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), loaded: i.complete && i.naturalWidth > 0, framed: !!i.closest('.att-img'), alt: i.alt };
  })()`);
  check('a picture sticker shows at 160 px, loaded, with no image frame', !!pic && pic.w === 160 && pic.h === 160 && pic.loaded && !pic.framed && pic.alt === 'Pogo', pic);

  await page.until(`!!document.querySelector('.sticker-lottie svg')`, 10000).catch(() => {});
  const lottie = await page.eval<{ svg: boolean; w: number; label: string | null } | null>(`(() => {
    const d = document.querySelector('.sticker-lottie');
    if (!d) return null;
    return { svg: !!d.querySelector('svg g'), w: Math.round(d.getBoundingClientRect().width), label: d.getAttribute('aria-label') };
  })()`);
  check('a Lottie sticker plays as an SVG at 160 px', !!lottie && lottie.svg && lottie.w === 160 && lottie.label === 'Pulse', lottie);
  if (shots) await page.shot(join(shots, 'stickers-desktop.png'));

  // ------------------------------------------------------------------ the emoji button, desktop
  await page.goto(`${base}/#/c/${dev.id}`);
  await page.until(`!!document.querySelector('.composer .composer-emoji')`, 15000);
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); })()`);
  await page.send('Input.insertText', { text: 'ab' });
  // The caret between a and b: a pick goes in there.
  await page.eval(`document.querySelector('.composer textarea').setSelectionRange(1, 1)`);
  await page.eval(`document.querySelector('.composer .composer-emoji').click()`);
  await page.until(`!!document.querySelector('.emoji-picker .ep-emoji')`, 10000);
  const look = await page.eval<{ label: string | null; superBtn: boolean; here: boolean; custom: boolean }>(`(() => {
    const p = document.querySelector('.emoji-picker');
    return {
      label: p.getAttribute('aria-label'),
      superBtn: !!p.querySelector('.ep-super'),
      here: [...p.querySelectorAll('.ep-section h4')].some((h) => h.textContent.includes('On this message')),
      custom: [...p.querySelectorAll('.ep-emoji')].some((b) => b.getAttribute('aria-label') === ':dither:'),
    };
  })()`);
  check('the emoji button opens the picker for writing, with the server\'s custom emoji and no reaction parts', look.label === 'Emoji' && !look.superBtn && !look.here && look.custom, look);
  if (shots) await page.shot(join(shots, 'emoji-picker-desktop.png'));
  check('a custom emoji can be picked', await pickEmoji(':dither:'));
  await Bun.sleep(150);
  check('it goes in at the caret as Discord markup, and the picker closes', (await value()) === 'a<:dither:9001>b' && !(await pickerOpen()), await value());

  await page.eval(`document.querySelector('.composer .composer-emoji').click()`);
  await page.until(`!!document.querySelector('.emoji-picker .ep-emoji[aria-label=":joy:"]')`, 10000);
  check('Shift-click: a Unicode emoji goes in', await pickEmoji(':joy:', true));
  await Bun.sleep(150);
  check('…and the picker stays open for another', (await pickerOpen()) && (await value()).includes('😂'), await value());
  await pickEmoji(':joy:');
  await Bun.sleep(150);
  check('a plain click after it adds one more and closes', (await value()).split('😂').length === 3 && !(await pickerOpen()), await value());

  // ------------------------------------------------------------------ a phone
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.select(); document.execCommand('delete'); })()`);
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/${dm.id}`);
  await page.until(`!!document.querySelector('.app.phone .composer-row .composer-emoji')`, 20000);
  await page.eval(`document.activeElement?.blur?.()`);
  await page.eval(`document.querySelector('.composer-row .composer-emoji').click()`);
  await page.until(`!!document.querySelector('.emoji-picker .ep-emoji[aria-label=":joy:"]')`, 10000);
  check('on a phone the button sits in the composer and opens the picker', await pickerOpen());
  if (shots) await page.shot(join(shots, 'emoji-picker-phone.png'));
  await pickEmoji(':joy:');
  await Bun.sleep(200);
  const phoneState = await page.eval<{ v: string; focused: boolean }>(`({ v: document.querySelector('.composer textarea').value, focused: document.activeElement === document.querySelector('.composer textarea') })`);
  check('a pick on a phone goes in without focusing the box (the keyboard stays down)', phoneState.v.includes('😂') && !phoneState.focused, phoneState);
  // Jordan's DM is on Discord too, but no custom emoji of a server go into a DM here without Nitro: nothing to check.

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
