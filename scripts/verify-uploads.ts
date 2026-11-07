/**
 * Sending files (docs/uploads.md), in a real browser against a demo hub of its own on a fresh data dir:
 *
 *   - files that cannot go are shown in the composer with the reason: over Discord's limit, empty, unreadable; the
 *     one over the limit is never uploaded;
 *   - an upload shows its progress, and one cancelled midway leaves nothing on the hub;
 *   - a message sent while a file is still uploading waits for it, and the hub restarted in the middle of that upload
 *     keeps what had arrived: the upload carries on from there, the file finished before the restart is not sent
 *     again, and the message goes out with both files;
 *   - once sent, the hub's copies are gone.
 *
 *   bun scripts/verify-uploads.ts [--port 8670] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 *
 * Builds the web app unless --web names a build. The hub is this script's own child, so restarting it ends nothing
 * else. Upload speed is throttled in the browser so that progress can be seen.
 */
import { chmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8670'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-uploads-${PORT}-`));
mkdirSync(work, { recursive: true });
const data = join(work, 'data');
const spool = join(data, 'uploads');
const shots = opt('shots', '');

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const getJson = async (path: string) => {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
};
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve().then(fn).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`timed out: ${what}`);
}
/** The uploads on the hub's disk: id -> bytes there, and the size it will be. */
function spooled(): Record<string, { have: number; size: number }> {
  const out: Record<string, { have: number; size: number }> = {};
  for (const f of readdirSync(spool)) {
    const m = f.match(/^([0-9a-f]{24})\.json$/);
    if (m) out[m[1]] = { have: statSync(join(spool, m[1])).size, size: JSON.parse(readFileSync(join(spool, f), 'utf8')).size };
  }
  return out;
}

// ------------------------------------------------------------------ the app and the hub

let web = opt('web', '');
if (!web) {
  web = join(work, 'web');
  console.log('building the web app…');
  const b = Bun.spawnSync(['bunx', '--bun', 'vite', 'build', '--outDir', web, '--emptyOutDir'], { cwd: join(root, 'packages/web'), stdout: 'pipe', stderr: 'pipe' });
  if (b.exitCode !== 0) throw new Error('web build failed:\n' + b.stderr.toString());
}
if ((await fetch(`${base}/api/health`).catch(() => null))?.ok) throw new Error(`something is already listening on ${PORT}`);
const log = openSync(join(work, 'hub.log'), 'a');
let hub: ReturnType<typeof Bun.spawn> | null = null;
async function startHub() {
  hub = Bun.spawn(['bun', join(root, 'packages/hub/src/main.ts'), '--demo', '--data', data, '--port', String(PORT), '--host', '127.0.0.1', '--web', web], {
    env: { ...process.env, DITHER_DEMO_CHATTER: '0' },
    stdout: log,
    stderr: log,
  });
  await until(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok ?? false, 30_000, 'the hub did not start');
  await until(async () => (await getJson('/api/bootstrap')).accounts.every((a: any) => a.status === 'online'), 30_000, 'demo accounts not online');
}
async function stopHub() {
  hub?.kill('SIGTERM');
  await hub?.exited;
  hub = null;
}

// The files: one fine, one over Discord's 10 MB, one empty, one this user cannot read, one slow enough to watch.
const files = join(work, 'files');
mkdirSync(files, { recursive: true });
const small = join(files, 'notes.txt');
const big = join(files, 'too-big.bin');
const empty = join(files, 'empty.txt');
const locked = join(files, 'locked.txt');
const medium = join(files, 'photo-roll.bin');
writeFileSync(small, 'a small file\n'.repeat(100));
writeFileSync(big, new Uint8Array(11 * 1024 * 1024));
writeFileSync(empty, '');
writeFileSync(locked, 'you cannot read me');
chmodSync(locked, 0o000);
writeFileSync(medium, new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 253));
const MEDIUM = statSync(medium).size;

await startHub();
const boot = await getJson('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
// A Discord DM the demo answers: Discord's limit (10 MB) is the one the big file is over.
const discord = new Set(boot.accounts.filter((a: any) => a.network === 'discord' && a.capabilities.includes('sendMedia')).map((a: any) => a.id));
const conv = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord' && c.vantages.some((v: any) => discord.has(v.accountId)));
if (!conv) throw new Error('no Discord direct conversation to send in');

const { page, close } = await launch();
try {
  await page.size(1200, 800);
  await page.send('Network.enable');
  // What the app asks of the hub's uploads, and when.
  const reqs: { at: number; method: string; url: string; body?: string }[] = [];
  page.on('Network.requestWillBeSent', (p) => p.request.url.includes('/api/uploads') && reqs.push({ at: Date.now(), method: p.request.method, url: p.request.url, body: p.request.postData }));

  await page.goto(`${base}/#/inbox/c/${conv.id}`);
  await page.until(`!!document.querySelector('.composer textarea') && !!document.querySelector('.composer input[type=file]')`, 20000);
  const attach = async (paths: string[]) => {
    const { root: doc } = await page.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '.composer input[type=file]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: paths });
  };
  const chips = () =>
    page.eval<{ name: string; status: string; why: string | null; pct: number | null }[]>(`[...document.querySelectorAll('.composer-file')].map(e => ({
      name: e.querySelector('.composer-file-name')?.textContent ?? '',
      status: e.dataset.status,
      why: e.querySelector('.composer-file-why')?.textContent ?? null,
      pct: e.querySelector('[role=progressbar]') ? Number(e.querySelector('[role=progressbar]').getAttribute('aria-valuenow')) : null,
    }))`);
  const chip = async (name: string) => (await chips()).find((c) => c.name === name);

  // ------------------------------------------------------------------ refused files say why

  await attach([small, big, empty, locked]);
  await page.until(`document.querySelectorAll('.composer-file').length === 4`, 5000);
  const tooBig = await chip('too-big.bin');
  check('a file over the network limit is shown, naming the limit', tooBig?.status === 'refused' && /Over Discord’s 10 MB limit/.test(tooBig.why ?? ''), tooBig);
  const none = await chip('empty.txt');
  check('an empty file is shown as empty', none?.status === 'refused' && none.why === 'Empty file', none);
  const unread = await chip('locked.txt');
  check('an unreadable file is shown as unreadable', unread?.status === 'refused' && /Cannot be read/.test(unread.why ?? ''), unread);
  await page.until(`document.querySelector('.composer-file[data-status=done] .composer-file-name')?.textContent === 'notes.txt'`, 10000).then(
    () => check('the file that fits uploads', true),
    async () => check('the file that fits uploads', false, await chips()),
  );
  check('…and only that one went to the hub', reqs.filter((r) => r.url.endsWith('/api/uploads/start')).length === 1 && Object.keys(spooled()).length === 1, { starts: reqs.filter((r) => r.url.endsWith('/api/uploads/start')).map((r) => r.body), spooled: spooled() });

  // Slow uploads from here on, about 200 KB/s, so there is progress to see.
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 200 * 1024 });

  // ------------------------------------------------------------------ progress, and a cancel midway

  await attach([medium]);
  const pcts: number[] = [];
  await until(async () => {
    const c = await chip('photo-roll.bin');
    if (c?.pct != null) pcts.push(c.pct);
    return (c?.pct ?? 0) >= 15;
  }, 30_000, 'the upload to reach 15%').catch(() => {});
  check('an upload shows its progress as it goes', new Set(pcts.filter((p) => p > 0 && p < 100)).size >= 2, pcts);
  if (shots) mkdirSync(shots, { recursive: true }), await page.shot(join(shots, 'uploads-composer.png'));
  const cancelled = Object.entries(spooled()).find(([, s]) => s.size === MEDIUM)?.[0];
  await page.eval(`[...document.querySelectorAll('.composer-file')].find(e => e.querySelector('.composer-file-name')?.textContent === 'photo-roll.bin')?.querySelector('button[aria-label^="Cancel uploading"]')?.click()`);
  await page.until(`![...document.querySelectorAll('.composer-file-name')].some(e => e.textContent === 'photo-roll.bin')`, 3000).then(
    () => check('cancelling takes it out of the composer', true),
    async () => check('cancelling takes it out of the composer', false, await chips()),
  );
  await until(() => !!cancelled && !(cancelled in spooled()), 5000, 'the hub to drop it').then(
    () => check('…and the hub keeps nothing of it', true),
    () => check('…and the hub keeps nothing of it', false, { cancelled, spooled: spooled() }),
  );

  // ------------------------------------------------------------------ sent while uploading, the hub restarted midway

  await attach([medium]);
  const text = `two files ${Date.now().toString(36)}`;
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.until(`[...document.querySelectorAll('.msg.pending')].some(e => e.textContent.includes(${JSON.stringify(text)}) && e.querySelector('.pending-note')?.textContent === 'Uploading…')`, 5000).then(
    () => check('sent while a file uploads: it waits, saying it is uploading', true),
    async () => check('sent while a file uploads: it waits, saying it is uploading', false, await page.eval(`document.querySelector('.msg.pending')?.textContent ?? null`)),
  );
  check('…and the composer is free again', (await chips()).length === 0, await chips());
  const pendingPct = await page.eval<string | null>(`document.querySelector('.msg.pending .pending-upload')?.textContent ?? null`);
  check('…with how far the file has got on the pending message', /\d+%/.test(pendingPct ?? ''), pendingPct);

  let mid = '';
  await until(() => {
    const e = Object.entries(spooled()).find(([, s]) => s.size === MEDIUM && s.have > MEDIUM * 0.25);
    if (e) mid = e[0];
    return !!e;
  }, 60_000, 'a quarter of the file on the hub');
  const smallId = Object.entries(spooled()).find(([, s]) => s.size !== MEDIUM)?.[0];
  await stopHub();
  const kept = spooled();
  check('the hub stopped with the file a part of the way', !!kept[mid] && kept[mid].have > 0 && kept[mid].have < MEDIUM, kept[mid]);
  const restartAt = Date.now();
  await startHub();
  const after = spooled();
  check('restarted: what had arrived is still there, and the finished file too', after[mid]?.have === kept[mid].have && !!smallId && after[smallId]?.have === after[smallId]?.size, { mid: after[mid], small: smallId && after[smallId] });

  await page.until(`(() => { const t = ${JSON.stringify(text)}; return [...document.querySelectorAll('.timeline-scroll .msg:not(.pending) .msg-body')].some(e => e.textContent.trim() === t) && ![...document.querySelectorAll('.timeline-scroll .msg.pending')].length; })()`, 90_000).then(
    () => check('the message goes out after the restart, by itself', true),
    async () => check('the message goes out after the restart, by itself', false, await page.eval(`document.querySelector('.msg.pending')?.textContent ?? null`)),
  );
  const afterReqs = reqs.filter((r) => r.at >= restartAt);
  const firstPut = afterReqs.find((r) => r.method === 'PUT');
  const offset = firstPut ? Number(new URL(firstPut.url).searchParams.get('offset')) : -1;
  check('the upload carried on from where it was, not from the start', offset > 0 && offset >= kept[mid].have - 2 * 1024 * 1024, { offset, had: kept[mid].have });
  check('…and no file was uploaded again', !afterReqs.some((r) => r.url.endsWith('/api/uploads/start') || (r.method === 'POST' && r.url.endsWith('/api/uploads'))), afterReqs.map((r) => `${r.method} ${r.url}`));
  const msgs = (await getJson(`/api/conversations/${conv.id}/messages?limit=20`)).messages;
  const mine = msgs.find((m: any) => m.body === text);
  check('…with both files', mine?.attachments?.length === 2 && mine.attachments.map((a: any) => a.name).sort().join() === 'notes.txt,photo-roll.bin', mine?.attachments?.map((a: any) => [a.name, a.size]));
  check('…once', msgs.filter((m: any) => m.body === text).length === 1);
  check('sent: the hub has deleted its copies', Object.keys(spooled()).length === 0 && readdirSync(spool).length === 0, readdirSync(spool));
  await until(async () => (await getJson(`/api/conversations/${conv.id}/messages?limit=5`)).messages.some((m: any) => m.ts > mine.ts && m.authorId !== mine.authorId), 15_000, 'a reply').then(
    () => check('the demo answers it', true),
    () => check('the demo answers it', false),
  );

  // Last, since a phone's layout is another composer: the same files at a phone's width.
  if (shots) {
    await page.size(390, 844, true);
    await page.until(`!!document.querySelector('.composer input[type=file]')`, 5000);
    await attach([small, big, empty, locked, medium]);
    await Bun.sleep(1500);
    await page.shot(join(shots, 'uploads-composer-phone.png'));
  }

  const errors = page.errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} finally {
  await close();
  await stopHub();
  chmodSync(locked, 0o600);
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
