/**
 * Stickers, voice messages, view-once and stories (docs/media-kinds.md) in a real browser against a demo hub of its
 * own on a fresh data dir: the sticker picker sends one, a recording made with Chromium's fake microphone goes out as
 * Ogg Opus with its length and waveform, view-once is offered for files on Signal and not on Discord, and a contact's
 * story shows on their page, opens, and takes a reply.
 *
 *   bun scripts/verify-media-kinds.ts [--port 8692] [--web <built dist>] [--work <empty dir>] [--keep] [--shots <dir>]
 */
import { mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const PORT = Number(opt('port', '8692'));
const root = resolve(import.meta.dir, '..');
const base = `http://127.0.0.1:${PORT}`;
const work = args.includes('--work') ? opt('work', '') : mkdtempSync(join(tmpdir(), `dither-verify-media-${PORT}-`));
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
const group = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Climbing crew 🧗');
const discord = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'dev');
const alice = boot.identities.find((i: any) => i.network === 'signal' && i.displayName === 'Alice Chen');
if (!group || !discord || !alice) throw new Error('the demo world lacks the Signal group, #dev or Alice');
const messages = async (convId: string): Promise<any[]> => {
  const r = (await fetch(`${base}/api/conversations/${convId}/messages?limit=10`).then((x) => x.json())) as any;
  return Array.isArray(r) ? r : (r.messages ?? []);
};

// A fake microphone that plays a tone, and no permission prompt: the press is what asks.
const { page, close } = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const click = (sel: string) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
try {
  await page.size(1200, 800);
  await page.goto(`${base}/#/inbox/c/${group.id}`);
  await page.until(`!!document.querySelector('.composer textarea')`, 20000);
  await Bun.sleep(500);

  // ------------------------------------------------------------------ stickers
  // On a computer stickers are in the + menu (docs/sending.md "The + menu").
  check('no sticker button in the box on a computer', await page.eval(`!document.querySelector('.composer .composer-sticker')`));
  await click('.composer-plus-menu');
  await page.until(`!!document.querySelector('.plus-menu [data-track="stickers"]')`, 5000);
  check('the + menu offers Sticker on Signal', true);
  await click('.plus-menu [data-track="stickers"]');
  await page.until(`document.querySelectorAll('.sticker-picker .sticker-choice').length > 0`, 10000);
  check("the picker shows the account's pack, and no More when there is no next page", await page.eval(`!document.querySelector('.sticker-tab.more') && document.querySelectorAll('.sticker-tab:not(.more)').length === 1`));
  check('Signal offers to install a pack from a link', await page.eval(`!!document.querySelector('.sticker-install input')`));
  if (shots) await page.shot(join(shots, 'sticker-picker.png'));
  await click('.sticker-picker .sticker-choice');
  await until(async () => (await messages(group.id)).some((m: any) => m.kind === 'sticker'), 10000, 'the sticker message');
  const st = (await messages(group.id)).find((m: any) => m.kind === 'sticker');
  check('picking one sends it as a sticker', st?.attachments?.length === 1, st?.attachments?.[0]?.name);

  // ------------------------------------------------------------------ a voice message
  check('an empty box shows the microphone where send is', await page.eval(`!!document.querySelector('.composer .composer-mic') && !document.querySelector('.composer .send-btn[data-track="send"]')`));
  await click('.composer-mic');
  await page.until(`!!document.querySelector('.voice-rec .voice-rec-dot')`, 10000);
  await Bun.sleep(1600);
  check('recording: the bars move with the sound', await page.eval(`[...document.querySelectorAll('.voice-rec-bars i')].some(i => parseFloat(i.style.height) > 8)`));
  if (shots) await page.shot(join(shots, 'voice-recording.png'));
  await click('.voice-rec button[data-track="stop recording"]');
  await page.until(`!!document.querySelector('.voice-rec audio')`, 10000);
  check('stopped: a player to listen before sending', await page.eval(`!!document.querySelector('.voice-rec button[data-track="play recording"]')`));
  if (shots) await page.shot(join(shots, 'voice-preview.png'));
  await click('.voice-rec button[data-track="send recording"]');
  await until(async () => (await messages(group.id)).some((m: any) => m.attachments?.some((a: any) => a.kind === 'audio')), 15000, 'the voice message');
  const vm = (await messages(group.id)).find((m: any) => m.attachments?.some((a: any) => a.kind === 'audio'));
  const att = vm.attachments.find((a: any) => a.kind === 'audio');
  check("Chromium's WebM recording went out as Ogg Opus", att.mime === 'audio/ogg' && /\.ogg$/.test(att.name), { mime: att.mime, name: att.name });
  check('with its length and a waveform', (att.voice?.seconds ?? 0) > 1 && (att.voice?.seconds ?? 9) < 4 && !!att.voice?.waveform, att.voice);
  const res: Response = await fetch(new URL(String(att.url), base).href);
  const bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  check('the file is an Ogg stream that says Opus', new TextDecoder().decode(bytes.subarray(0, 4)) === 'OggS' && new TextDecoder().decode(bytes.subarray(28, 36)) === 'OpusHead');
  if (args.includes('--keep')) writeFileSync(join(work, 'voice.ogg'), bytes);

  // ------------------------------------------------------------------ view-once
  const png = join(work, 'p.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const attach = async () => {
    const { root: doc } = await page.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await page.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '.composer input[type=file]' });
    await page.send('DOM.setFileInputFiles', { nodeId, files: [png] });
  };
  await attach();
  await page.until(`!!document.querySelector('.view-once-chip')`, 10000);
  check('a file attached on Signal: View once is offered', true);
  await click('.view-once-chip');
  check('pressed, it is on', await page.eval(`document.querySelector('.view-once-chip').getAttribute('aria-pressed') === 'true'`));
  await page.until(`!document.querySelector('.composer .send-btn[data-track="send"]')?.disabled`, 10000);
  await click('.composer .send-btn[data-track="send"]');
  await until(async () => (await messages(group.id)).some((m: any) => m.body === '📷 View-once media'), 10000, 'the view-once message');
  check('sent view-once: your copy is a placeholder', true);

  await page.goto(`${base}/#/inbox/c/${discord.id}`);
  await page.until(`!!document.querySelector('.composer textarea')`, 20000);
  await Bun.sleep(400);
  await attach();
  await page.until(`!!document.querySelector('.composer-file')`, 10000);
  check('on Discord: no View once', await page.eval(`!document.querySelector('.view-once-chip')`));

  // ------------------------------------------------------------------ stories
  await page.goto(`${base}/#/i/${alice.id}`);
  await until(() => page.eval(`!!document.querySelector('.pf-stories .story-thumb')`), 20000, "Alice's stories on her page");
  check("a contact's story on their page", true);
  if (shots) await page.shot(join(shots, 'stories-card.png'));
  await click('.pf-stories .story-thumb');
  await page.until(`!!document.querySelector('.story-viewer .story-text')`, 10000);
  if (shots) await page.shot(join(shots, 'story-viewer.png'));
  await until(async () => (await fetch(`${base}/api/stories?identity=${alice.id}`).then((r) => r.json()))[0]?.viewed === true, 5000, 'seen');
  check('opening it marks it seen', true);
  await page.eval(`(() => { const i = document.querySelector('.story-reply input'); i.focus(); })()`);
  await page.send('Input.insertText', { text: 'looks cold' });
  await click('.story-reply form button[type=submit]');
  await until(() => page.eval(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('Replied'))`), 10000, 'the reply toast');
  check('a reply goes, and says where', true);

  // ------------------------------------------------------------------ a phone
  await page.size(390, 844, true);
  await page.goto(`${base}/#/inbox/c/${group.id}`);
  await page.until(`!!document.querySelector('.app.phone .composer textarea')`, 20000);
  await Bun.sleep(500);
  const fit = await page.eval<{ sticker: boolean; mic: boolean; right: number; width: number }>(`(() => {
    const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
    return { sticker: !!r('.composer .composer-sticker'), mic: !!r('.composer .composer-mic'), right: Math.round(Math.max(r('.composer .composer-mic')?.right ?? 0, r('.composer-box')?.right ?? 0)), width: innerWidth };
  })()`);
  check('on a phone: sticker and microphone in the box, nothing past the edge', fit.sticker && fit.mic && fit.right <= fit.width, fit);
  if (shots) await page.shot(join(shots, 'phone-composer.png'));
  await click('.composer-plus');
  await page.until(`!!document.querySelector('.attach-sheet')`, 5000);
  check("the phone's attach sheet offers View once on Signal", await page.eval(`!!document.querySelector('.attach-sheet [data-track="view once"]')`));

  const errors = page.errors.filter((e) => !/WebSocket connection|Failed to load resource/.test(e));
  check('no script errors', !errors.length, errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot(join(shots, 'failure.png')).catch(() => {});
} finally {
  await close();
  hub.kill('SIGTERM');
  await hub.exited;
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
