/**
 * The desktop helper end to end, in headless Chromium against a demo hub: pair through Settings with the code the
 * `pair` command prints, click a link in a message, Open Link from its menu, Open With… on a file, Open File from the
 * file's viewer, and a click on a file with no viewer. The helper runs here with a recording stand-in for xdg-open and
 * gio, so nothing is ever opened.
 *
 *   bun scripts/verify-desk.ts http://127.0.0.1:8680 8681 /tmp/desk-verify
 * The hub must be a demo hub (--demo) with its own data dir. Port 8681 must be free.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8680';
const deskPort = Number(process.argv[3] ?? 8681);
const dir = process.argv[4] ?? '/tmp/dither-desk-verify';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const repo = new URL('..', import.meta.url).pathname;
const fixtures = join(repo, 'packages/desk/test/fixtures');
const log = join(dir, 'opened.log');
const downloads = join(dir, 'Downloads');
const recorder = `bun ${join(fixtures, 'record.ts')} ${log}`;
const env = {
  ...process.env,
  DESK_PORT: String(deskPort),
  DESK_CONFIG_DIR: join(dir, 'config'),
  DESK_DOWNLOAD_DIR: downloads,
  DESK_OPEN_CMD: recorder,
  DESK_GIO_CMD: recorder,
  XDG_DATA_HOME: fixtures,
  XDG_DATA_DIRS: join(dir, 'none'),
};
const main = join(repo, 'packages/desk/src/main.ts');

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const showcase = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'showcase');
const pdfConv = ((await fetch(`${hub}/api/search?q=local-first-chat-sync`).then((r) => r.json())) as any).hits[0].message.conversationId;
const LINK = 'https://github.com/example/ntfy-tui';

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const opened = (): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] !== 'mime') : []);
async function waitFor(fn: () => boolean, ms = 5000) {
  for (let t = 0; t < ms && !fn(); t += 100) await Bun.sleep(100);
  return fn();
}

const helper = Bun.spawn(['bun', main], { env, stdout: 'pipe', stderr: 'inherit' });
for (let i = 0; i < 50; i++) {
  if (await fetch(`http://127.0.0.1:${deskPort}/hello`).then((r) => r.ok).catch(() => false)) break;
  await Bun.sleep(100);
}

const b = await launch();
const p: Page = b.page;
try {
  async function mouse(type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none') {
    await p.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  async function click(x: number, y: number, button: 'left' | 'right' = 'left') {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, button);
    await mouse('mouseReleased', x, y, button);
    await Bun.sleep(150);
  }
  const center = (sel: string) =>
    p.eval<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 }; })()`,
    );
  const items = () => p.eval<string[]>(`[...document.querySelectorAll('.cm:last-of-type .cm-item .cm-text')].map((e) => e.textContent)`);
  const clickItem = async (label: string) => {
    const at = await p.eval<{ x: number; y: number } | null>(
      `(() => { const e = [...document.querySelectorAll('.cm:last-of-type .cm-item')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!at) throw new Error(`no item ${label}`);
    await click(at.x, at.y);
  };
  const tabs = async () => ((await fetch(`http://127.0.0.1:${b.port}/json`).then((r) => r.json())) as any[]).filter((t) => t.type === 'page').length;

  await p.size(1280, 800);

  // ---------------------------------------------------------------- pairing
  await p.goto(`${hub}/#/settings`);
  // Unpaired, Settings doesn't knock on 127.0.0.1 by itself: no refused connection, no local-network prompt.
  await p.until(`document.querySelector('[data-desk-status="unchecked"]')`, 15000);
  await Bun.sleep(1500);
  check((await p.eval(`document.querySelector('#set-desk [data-desk-status]').dataset.deskStatus`)) === 'unchecked', 'unpaired, opening Settings does not look for the helper');
  // Not on the default port here: type this one.
  await p.eval(`(() => {
    const i = document.querySelector('input[aria-label="Helper port"]');
    i.value = '${deskPort}';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await p.until(`document.querySelector('[data-desk-status="unpaired"]')`, 5000);
  check(true, 'Settings finds the unpaired helper on the port typed');
  const pairing = Bun.spawn(['bun', main, 'pair'], { env, stdout: 'pipe', stderr: 'inherit' });
  const reader = pairing.stdout.getReader();
  let out = '';
  while (!/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(out)) out += new TextDecoder().decode((await reader.read()).value);
  const code = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
  await p.eval(`(() => {
    const i = document.querySelector('input[aria-label="Pairing code"]');
    i.value = ${JSON.stringify(code.toLowerCase())};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await Bun.sleep(100);
  await p.eval(`document.querySelector('#set-desk form button').click()`);
  await p.until(`document.querySelector('[data-desk-status="paired"]')`, 5000);
  check(true, 'pairing with the printed code shows Paired');
  while (!/Paired with/.test(out)) out += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  check(out.includes(`Paired with ${hub}`), `the pair command says which page took it: ${out.trim().split('\n').pop()}`);
  const toggles = await p.eval<boolean[]>(`[...document.querySelectorAll('#set-desk input[type=checkbox]')].map((i) => i.checked)`);
  check(toggles.length === 2 && toggles.every(Boolean), 'both switches are on once paired');
  await p.shot(join(dir, 'settings-paired.png'));

  // ---------------------------------------------------------------- links
  await p.goto(`${hub}/#/s/${showcase.spaceIds[0]}/c/${showcase.id}`);
  await p.until(`document.querySelector('.msg-body a[href="${LINK}"]')`, 15000);
  const before = await tabs();
  let at = (await center(`.msg-body a[href="${LINK}"]`))!;
  await click(at.x, at.y);
  check(await waitFor(() => opened().some((a) => a.length === 1 && a[0] === LINK)), `a click on a link in a message: the opener got [${LINK}]`);
  check((await tabs()) === before, 'and no tab opened in the browser');

  await click(at.x, at.y, 'right');
  check((await items()).includes('Open Link'), 'the link menu has Open Link');
  await clickItem('Open Link');
  check(await waitFor(() => opened().filter((a) => a[0] === LINK).length === 2), 'Open Link from the menu goes to the opener too');

  // ---------------------------------------------------------------- files
  await p.goto(`${hub}/#/c/${pdfConv}`);
  await p.until(`document.querySelector('.att-file')`, 15000);
  const href = await p.eval<string>(`document.querySelector('.att-file').getAttribute('href')`);
  check(href.startsWith('/media/'), `the demo PDF is a hub file: ${href.slice(0, 20)}…`);
  at = (await center('.att-file'))!;
  await click(at.x, at.y, 'right');
  const fileItems = await items();
  console.log('     file menu:', fileItems.join(' | '));
  check(fileItems.includes('Open File') && fileItems.includes('Open With…'), 'the file menu has Open File and Open With…');
  await clickItem('Open With…');
  await p.until(`[...document.querySelectorAll('.cm-item .cm-text')].some((e) => e.textContent === 'Other App')`, 5000);
  const apps = await items();
  check(JSON.stringify(apps) === JSON.stringify(['Editor (default)', 'Other App', 'Viewer']), `Open With… lists the apps for the type, default first: ${apps.join(', ')}`);
  await p.shot(join(dir, 'open-with.png'));
  await clickItem('Other App');
  const pdf = join(downloads, 'local-first-chat-sync.pdf');
  check(await waitFor(() => opened().some((a) => a[0] === 'launch')), 'picking an app launches it through gio');
  const launch_ = opened().find((a) => a[0] === 'launch');
  check(JSON.stringify(launch_) === JSON.stringify(['launch', join(fixtures, 'applications/other.desktop'), pdf]), `with its desktop file and the downloaded file: ${JSON.stringify(launch_)}`);
  check(existsSync(pdf) && readFileSync(pdf, 'latin1').startsWith('%PDF-'), 'the PDF was downloaded into the folder');

  // A PDF has a viewer in the app (docs/files.md): a click opens it, and its header hands the file to the desktop.
  const tabsBefore = await tabs();
  await click(at.x, at.y);
  await p.until(`document.querySelector('.fviewer')?.dataset.kind === 'pdf'`, 10000);
  const head = await p.eval<string[]>(`[...document.querySelectorAll('.fviewer-bar [aria-label]')].map((e) => e.getAttribute('aria-label'))`);
  check(['Open File', 'Open With…', 'Download'].every((l) => head.includes(l)), `a click on the PDF opens the viewer, its header: ${head.join(', ')}`);
  await p.shot(join(dir, 'viewer-paired.png'));
  await p.eval(`document.querySelector('.fviewer-bar button[aria-label="Open File"]').click()`);
  const second = join(downloads, 'local-first-chat-sync (2).pdf');
  check(await waitFor(() => opened().some((a) => a.length === 1 && a[0] === second)), "the viewer's Open File downloads it again and hands it to the opener");
  check((await tabs()) === tabsBefore, 'and no tab opened in the browser');
  await p.eval(`document.querySelector('.fviewer-bar button[aria-label="Close"]').click()`);
  // Closing goes back a step in history (phone.ts layers): let it land before going elsewhere.
  await p.until(`!document.querySelector('.fviewer')`, 3000);
  await Bun.sleep(500);

  // A type with no viewer: a click hands it to the opener, as before.
  const house = boot.conversations.find((c: any) => c.name === 'Housemates');
  await p.goto(`${hub}/#/c/${house.id}`);
  const xlsx = `[...document.querySelectorAll('.att-file')].find((a) => a.querySelector('b')?.textContent === 'rent-split.xlsx')`;
  await p.until(`!!${xlsx}`, 15000);
  at = (await p.eval<{ x: number; y: number }>(`(() => { const e = ${xlsx}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`))!;
  await click(at.x, at.y);
  const sheet = join(downloads, 'rent-split.xlsx');
  check(await waitFor(() => opened().some((a) => a.length === 1 && a[0] === sheet)), 'a click on a file with no viewer here (a spreadsheet) hands it to the opener');
  check(!(await p.eval(`!!document.querySelector('.fviewer')`)) && (await tabs()) === tabsBefore, 'with no viewer and no tab');
  console.log('     downloads:', readdirSync(downloads).join(', '));

  // ---------------------------------------------------------------- unpair
  await p.goto(`${hub}/#/settings`);
  await p.until(`document.querySelector('[data-desk-status="paired"]')`, 10000);
  await p.eval(`[...document.querySelectorAll('#set-desk button')].find((b) => b.textContent === 'Unpair').click()`);
  await p.until(`document.querySelector('[data-desk-status="unpaired"]')`, 5000);
  check(!existsSync(join(dir, 'config/paired.json')), 'Unpair forgets the page on the helper too');
  const n = opened().length;
  await p.goto(`${hub}/#/s/${showcase.spaceIds[0]}/c/${showcase.id}`);
  await p.until(`document.querySelector('.msg-body a[href="${LINK}"]')`, 15000);
  at = (await center(`.msg-body a[href="${LINK}"]`))!;
  const tabsUnpaired = await tabs();
  await click(at.x, at.y);
  await Bun.sleep(800);
  check(opened().length === n && (await tabs()) === tabsUnpaired + 1, 'unpaired, a link opens in a browser tab as before');
  // The first look on the default port, where nothing runs here, is refused: expected.
  const errors = p.errors.filter((e) => !e.includes('ERR_CONNECTION_REFUSED'));
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await b.close();
  helper.kill();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
