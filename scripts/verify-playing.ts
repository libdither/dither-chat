/**
 * Playing on after leaving a chat (docs/media-kinds.md "Playing in the background"), in headless Chromium against a demo
 * hub of its own, with real mouse and touch input. A voice message and a sound file are sent into a demo chat first
 * (the demo world has neither); both play in the app's one player (nowplaying.ts), their rows being its controls.
 *
 * Computer: a row's Play plays it and the other row's stops, leaving the chat keeps it playing with the playing bar
 * under the list, the bar pauses and plays it, its title goes back to the message (and the bar goes there, the row
 * showing where it got to), Close stops it, and the end takes the bar away. Phone: the bar is the top of the screen
 * and the list starts below it.
 *
 *   bun run web:build && bun scripts/verify-playing.ts            # starts a demo hub of its own
 *   bun scripts/verify-playing.ts http://127.0.0.1:8881 [shots]    # or uses one: a demo hub with its own data dir
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const own = process.argv[2] ? null : await ownHub();
// Whatever fails before the browser's own try, the hub goes with it.
process.on('uncaughtException', async (e) => (console.error(e), await own?.stop(), process.exit(1)));
process.on('unhandledRejection', async (e) => (console.error(e), await own?.stop(), process.exit(1)));
const hub = process.argv[2] || own!.url;
async function ownHub() {
  const data = mkdtempSync(join(tmpdir(), 'dither-playing-hub-'));
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];
  const proc = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  while (!(await fetch(`${url}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the demo hub did not start');
    await Bun.sleep(200);
  }
  // The hub writes its last traces as it exits: its folder goes only after that.
  const stop = async () => (proc.kill(), await proc.exited, rmSync(data, { recursive: true, force: true }));
  return { url, stop };
}

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
  if (!ok) failures++;
};

/** `seconds` of a quiet tone as a WAV, 8 kHz mono. */
function tone(seconds: number, hz: number): Uint8Array<ArrayBuffer> {
  const rate = 8000;
  const n = rate * seconds;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const s = (o: number, x: string) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  s(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  s(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * hz) * 600, true);
  return new Uint8Array(v.buffer);
}

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const group = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Climbing crew 🧗');
const other = boot.conversations.find((c: any) => c.network === 'discord' && c.name === 'dev');
if (!group || !other) throw new Error('the demo world lacks the Signal group or #dev');

async function send(name: string, bytes: Uint8Array<ArrayBuffer>, voice?: { seconds: number; waveform?: string }): Promise<string> {
  const up = (await fetch(`${hub}/api/uploads`, { method: 'POST', headers: { 'content-type': 'audio/wav', 'x-file-name': name }, body: bytes }).then((r) => r.json())) as any;
  if (!up?.id) throw new Error(`upload failed: ${JSON.stringify(up)}`);
  const r = (await fetch(`${hub}/api/conversations/${group.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: '', attachments: [up.id], ...(voice ? { voice } : {}) }) }).then((x) => x.json())) as any;
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const page = (await fetch(`${hub}/api/conversations/${group.id}/messages?limit=10`).then((x) => x.json())) as any;
    const msgs: any[] = Array.isArray(page) ? page : (page.messages ?? []);
    const m = msgs.find((x) => x.attachments?.some((a: any) => a.name === name || (voice && a.voice)));
    if (m) return m.id;
    await Bun.sleep(200);
  }
  throw new Error(`${name} did not arrive: ${JSON.stringify(r)}`);
}
// The demo's notices come live a few seconds after the hub starts (notices/fake.ts), each with a toast that a phone
// shows at the top of the screen, over the bar. Once the hub has them, a page loaded after finds them quietly.
{
  const end = Date.now() + 30_000;
  const has = async () => JSON.stringify(await fetch(`${hub}/api/notices`).then((r) => r.json(), () => null)).includes('Proton Mail stopped');
  while (!(await has())) {
    if (Date.now() > end) throw new Error("the demo's live notices did not come");
    await Bun.sleep(200);
  }
}
// A waveform as Discord gives one: base64 of a byte for each tenth of a second.
const waveform = Buffer.from(Array.from({ length: 80 }, (_, i) => Math.round(120 + 100 * Math.sin(i / 2.5) * Math.sin(i / 11)))).toString('base64');
// Long enough that neither ends on its own while the steps that need it playing run, however slow the machine.
const voiceId = await send('voice.wav', tone(40, 330), { seconds: 40, waveform });
const soundId = await send('tune.wav', tone(60, 440));

const b = await launch();
const p: Page = b.page;
type Pt = [number, number];
const VOICE = `document.querySelector('#m-${voiceId} .voice-msg')`;
const SOUND = `document.querySelector('#m-${soundId} .sound-file')`;
const BAR = `document.querySelector('.playing-bar')`;
/** The app's player: whether it plays, where, and the length of what it holds (the voice message is 40 s, the file 60 s). */
const player = () =>
  p.eval<{ paused: boolean; t: number; length: number } | null>(`(() => { const a = document.getElementById('app-player'); return a ? { paused: a.paused, t: a.currentTime, length: Math.round(a.duration) } : null })()`);
const label = (row: string) => p.eval<string | null>(`${row}?.querySelector('.voice-play')?.getAttribute('aria-label') ?? null`);
async function mid(sel: string): Promise<Pt> {
  const r = await p.eval(`(() => { const el = ${sel}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!r) throw new Error(`nothing to press: ${sel}`);
  return [r[0], r[1]];
}
const mouse = (type: string, [x, y]: Pt) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
async function click(sel: string) {
  const pt = await mid(sel);
  await mouse('mouseMoved', pt);
  await mouse('mousePressed', pt);
  await mouse('mouseReleased', pt);
}
const touch = (type: string, pts: Pt[]) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function tap(sel: string) {
  const pt = await mid(sel);
  await touch('touchStart', [pt]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
}
const playing = (n: number) => `(() => { const a = document.getElementById('app-player'); return !!a && !a.paused && a.currentTime > ${n} })()`;
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));

try {
  // ---------------------------------------------------------------- computer
  await p.size(1280, 800);
  await p.goto(`${hub}/#/inbox/c/${group.id}`);
  await p.until(`!!${VOICE} && !!${SOUND}`, 20_000);
  check((await label(VOICE)) === 'Play voice message' && (await label(SOUND)) === 'Play tune.wav', 'a voice message and a sound file, each with its Play');
  await shot('rows');

  await click(`${VOICE}.querySelector('.voice-play')`);
  await p.until(playing(0.3), 5000).catch(() => {});
  check((await player())?.length === 40, "the voice message's Play plays it in the app's player", await player());
  check((await label(VOICE)) === 'Pause voice message', 'and its row says Pause');

  await click(`${SOUND}.querySelector('.voice-play')`);
  await p.until(`${playing(0.3)} && Math.round(document.getElementById('app-player').duration) === 60`, 5000).catch(() => {});
  check((await player())?.length === 60, "the sound file's Play plays it instead", await player());
  check((await label(VOICE)) === 'Play voice message' && (await label(SOUND)) === 'Pause tune.wav', 'one plays at a time: the voice row goes back to Play');
  await p.until(playing(1), 5000).catch(() => {});
  await shot('rows-playing');

  // Away from the chat: it goes on, and the bar shows it.
  await p.goto(`${hub}/#/inbox/c/${other.id}`);
  await p.until(`!!${BAR}`, 5000).catch(() => {});
  const t0 = (await player())?.t ?? 0;
  await p.until(playing(t0 + 1), 5000).catch(() => {});
  const away = await player();
  check(away && !away.paused && away.t > t0 + 1, 'in another chat it plays on', { t0, away });
  const bar = await p.eval<{ title: string; text: string; top: number; listBottom: number; withBar: boolean } | null>(
    `(() => { const b = ${BAR}; if (!b) return null; const r = b.getBoundingClientRect(); return { title: b.querySelector('b')?.textContent, text: b.querySelector('small')?.textContent ?? '', top: Math.round(r.top), listBottom: Math.round(document.querySelector('.app > .sidebar').getBoundingClientRect().bottom), withBar: document.querySelector('.app').classList.contains('with-bar') } })()`,
  );
  check(bar?.title === 'tune.wav' && bar.text.includes('Climbing crew'), 'the playing bar names it and its chat', bar);
  check(bar && bar.withBar && bar.top >= bar.listBottom, 'under the list, which ends above it', bar);
  await shot('bar-computer');

  await click(`${BAR}.querySelector('button[aria-label="Pause"]')`);
  // paused turns true at once, and the pause event the bar redraws from comes a task later.
  await p.until(`!!${BAR}?.querySelector('button[aria-label="Play"]')`, 3000).catch(() => {});
  const paused = { player: await player(), bar: await p.eval(`${BAR}?.outerHTML ?? null`) };
  check(paused.player?.paused && /aria-label="Play"/.test(paused.bar ?? ''), "the bar's Pause pauses it, and it stays with Play", paused);
  await click(`${BAR}.querySelector('button[aria-label="Play"]')`);
  const t1 = (await player())?.t ?? 0;
  await p.until(playing(t1 + 0.3), 3000).catch(() => {});
  check(!(await player())?.paused, "the bar's Play plays it again");

  // Something else with sound plays meanwhile (a video, here a player of its own in the page): it pauses the app's
  // player, and the bar stays, to go on with it once that is done.
  const started = await p.eval<boolean>(
    `(() => { const a = document.createElement('audio'); a.id = 'other-sound'; a.src = 'data:audio/wav;base64,${Buffer.from(tone(30, 550)).toString('base64')}'; document.body.append(a); return a.play().then(() => true, () => false) })()`,
  );
  await p.until(`document.getElementById('app-player').paused && !!${BAR}?.querySelector('button[aria-label="Play"]')`, 3000).catch(() => {});
  check(started && (await player())?.paused && (await p.eval(`!!${BAR}`)), 'another sound pauses it, and the bar stays with Play', { started, player: await player() });
  await p.eval(`document.getElementById('other-sound').remove()`);
  await click(`${BAR}.querySelector('button[aria-label="Play"]')`);
  const t2 = (await player())?.t ?? 0;
  await p.until(playing(t2 + 0.3), 3000).catch(() => {});
  check(!(await player())?.paused && (await p.eval(`!!${BAR}?.querySelector('button[aria-label="Pause"]')`)), "once it's gone, the bar's Play goes on with the file", await player());

  // Its title goes back to the message: there, no bar, and the row shows where it got to.
  await click(`${BAR}.querySelector('.playing-bar-open')`);
  await p.until(`location.hash.includes(${JSON.stringify(group.id)}) && !!${SOUND}`, 5000).catch(() => {});
  await p.until(`!${BAR}`, 3000).catch(() => {});
  const back = await p.eval<{ bar: boolean; label: string | null; done: number }>(
    `(() => ({ bar: !!${BAR}, label: ${SOUND}?.querySelector('.voice-play')?.getAttribute('aria-label') ?? null, done: parseFloat(${SOUND}?.querySelector('.voice-line')?.style.width ?? '0') }))()`,
  );
  check(!back.bar && back.label === 'Pause tune.wav' && back.done > 0, 'its title goes back to the chat: no bar there, and the row shows it playing, part way', back);

  // Close.
  await p.goto(`${hub}/#/inbox/c/${other.id}`);
  await p.until(`!!${BAR}`, 5000).catch(() => {});
  await click(`${BAR}.querySelector('button[aria-label="Close"]')`);
  await p.until(`!${BAR}`, 3000).catch(() => {});
  check(!(await p.eval(`!!${BAR}`)) && (await player())?.paused, 'Close stops it and the bar goes');

  // The end.
  await p.goto(`${hub}/#/inbox/c/${group.id}`);
  await p.until(`!!${VOICE}`, 10_000);
  await click(`${VOICE}.querySelector('.voice-play')`);
  await p.until(playing(0.2), 5000).catch(() => {});
  await p.goto(`${hub}/#/inbox/c/${other.id}`);
  await p.until(`!!${BAR}`, 5000).catch(() => {});
  check(await p.eval(`${BAR}?.querySelector('b')?.textContent === 'Voice message'`), 'a voice message is called one on the bar');
  await p.eval(`(() => { const a = document.getElementById('app-player'); a.currentTime = a.duration - 0.3 })()`);
  await p.until(`!${BAR}`, 5000).catch(() => {});
  check(!(await p.eval(`!!${BAR}`)), 'its end takes the bar away');

  // ---------------------------------------------------------------- phone
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/inbox/c/${group.id}`);
  await p.until(`!!${VOICE}`, 10_000);
  await tap(`${VOICE}.querySelector('.voice-play')`);
  await p.until(playing(0.2), 5000).catch(() => {});
  check(!(await player())?.paused, 'a tap on Play plays it on a phone');
  await p.goto(`${hub}/#/inbox`);
  await p.until(`!!${BAR}`, 5000).catch(() => {});
  const ph = await p.eval<{ top: number; bottom: number; list: number } | null>(
    `(() => { const b = ${BAR}; if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), list: Math.round(document.querySelector('.app > .sidebar').getBoundingClientRect().top) } })()`,
  );
  check(ph && ph.top === 0 && ph.list >= ph.bottom, 'in the list: the bar is the top of the screen, the list below it', ph);
  check(!(await player())?.paused, 'and it plays on');
  await shot('bar-phone');
  await tap(`${BAR}.querySelector('button[aria-label="Close"]')`);
  await p.until(`!${BAR}`, 3000).catch(() => {});
  check(!(await p.eval(`!!${BAR}`)), 'Close on a phone', await player());

  check(p.errors.length === 0, 'no page errors', p.errors);
} finally {
  await b.close?.();
  await own?.stop();
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
