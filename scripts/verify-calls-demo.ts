/**
 * Calls end to end on a demo hub (docs/calls.md "Demo calls"): two devices in headless Chromium, as the demo's two
 * Discord accounts, in the libdither server's voice channel, and the demo call room in a third browser as the far end
 * of both. Checks, through the app's own buttons:
 *
 * - joining: live, and connected, in good time; the join sound; the call room hears the device's microphone and the
 *   device hears the room's bot; the bot's camera shows on a video slot;
 * - a second device joining plays the join sound on the first, and each is in the other's people;
 * - mute and unmute reach the far end, with their sounds;
 * - the first device's camera reaches the far end and shows on the second device;
 * - the first device shares its screen: the far end gets it, the second device presses Watch and sees it;
 * - watching the bot's Go Live;
 * - the second device leaving plays the leave sound on the first; leaving ends the call everywhere;
 * - a device with no microphone still joins, listening only;
 * - no page errors.
 *
 *   bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-calls-demo.ts http://127.0.0.1:8579
 *
 * Use a fresh demo world each run (it joins a call; nothing in it changes otherwise).
 */
import { launch, type Page } from './browser.ts';

const hub = (process.argv[2] ?? 'http://127.0.0.1:8579').replace(/\/$/, '');
const MAIN = 'acc_demo-discord-main';
const ALT = 'acc_demo-discord-alt';

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const voice = boot.conversations.find((c: any) => c.variant === 'voice' && c.vantages.some((v: any) => v.accountId === MAIN) && c.vantages.some((v: any) => v.accountId === ALT));
if (!voice) throw new Error('no voice channel both demo Discord accounts see');
const selfOf = (acc: string) => boot.accounts.find((a: any) => a.id === acc)?.selfIdentityId as string;
/** The first account's name as the second device shows it, as a pattern for the tiles and people. */
const mainIdn = boot.identities?.find((i: any) => i.id === selfOf(MAIN));
const mainName = String(mainIdn?.displayName ?? mainIdn?.handle ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!mainName) throw new Error("no name for the first demo account's identity in the bootstrap");

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const wait = async (p: Page, expr: string, ms = 15_000) => p.until(expr, ms).then(() => true, () => false);

const MEDIA = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-accept-this-tab-capture', '--enable-usermedia-screen-capturing'];
const room = await launch({ args: MEDIA });
const a = await launch({ args: MEDIA });
const b = await launch({ args: MEDIA });
// No fake devices: getUserMedia finds no microphone.
const c = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const browsers = [room, a, b, c];

/** A device page as one demo account, in the voice channel's chat. */
async function device(p: Page, account: string) {
  await p.send('Runtime.enable');
  await p.goto(hub);
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: 'bridge', sendAs: { ${JSON.stringify(voice.id)}: ${JSON.stringify(account)} } }))`);
  await p.goto(`${hub}/?calls=1#/inbox/c/${voice.id}`);
  await p.until(`!!document.querySelector('.call-join')`, 30_000);
}
const call = <T = any>(p: Page, expr: string) => p.eval<T>(`(() => { const c = window.__activeCall.value; return ${expr}; })()`);
const sounds = (p: Page) => p.eval<string[]>(`window.__callSounds.map((s) => s.name)`);
const roomCalls = () => room.page.eval<any[]>(`window.__room.summary()`);
const roomCall = async (identity: string) => {
  const native = boot.identities?.find?.((i: any) => i.id === identity)?.nativeId;
  return (await roomCalls()).find((x) => x.self === native) ?? (await roomCalls()).find((x) => identity.endsWith(x.self));
};
const press = (p: Page, track: string) => p.eval(`document.querySelector('[data-track="${track}"]').click()`);

try {
  await room.page.goto(`${hub}/demo/callroom.html`);
  check(await wait(room.page, `/Open/.test(document.getElementById('status').textContent)`), 'the call room connects to the hub');

  // ------------------------------------------------------------ the first device joins
  await device(a.page, MAIN);
  const t0 = Date.now();
  await a.page.eval(`document.querySelector('.call-join').click()`);
  const live = await wait(a.page, `document.querySelector('[data-call-phase]')?.dataset.callPhase === 'live' && !!document.querySelector('[data-call-connected]')`, 20_000);
  const timing = await call(a.page, 'c && c.timing');
  check(live, 'the call goes live and connects', { ms: Date.now() - t0, timing });
  check(live && timing.connected < 5000, 'connected within 5 s of the click', timing);
  check(await wait(a.page, `window.__callSounds.some((s) => s.name === 'user_join')`, 5000), 'the join sound plays', await sounds(a.page));
  check(await wait(a.page, `(JSON.parse(document.querySelector('[data-call-stats]')?.dataset.callStats || '{}').inLevel ?? 0) > 0.01`, 15_000), 'the device hears the call (the bot talking)', await call(a.page, 'c && c.stats'));
  const heard = await wait(room.page, `window.__room.summary().some((x) => x.micLevel > 0.005)`, 15_000);
  check(heard, 'the far end hears the device\'s microphone', await roomCalls());
  check(await wait(a.page, `[...document.querySelectorAll('.call-video[data-video-slot] video')].some((v) => v.videoWidth > 0)`, 20_000), 'the bot\'s camera shows on a video slot', await call(a.page, 'c && c.video'));
  check(await wait(a.page, `parseFloat(getComputedStyle(document.querySelector('.call-btn.mic')).getPropertyValue('--mic-level')) > 0`, 8000), 'the microphone meter moves');

  // ------------------------------------------------------------ the second device joins
  await device(b.page, ALT);
  await b.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(b.page, `!!document.querySelector('[data-call-connected]')`, 20_000), 'the second device joins');
  check(await wait(a.page, `window.__activeCall.value.participants.length >= 3`, 10_000), 'the first device sees the second', await call(a.page, 'c.participants.map((p) => p.id)'));
  check(await wait(a.page, `window.__callSounds.filter((s) => s.name === 'user_join').length >= 2`, 5000), 'someone joining plays the join sound', await sounds(a.page));

  // ------------------------------------------------------------ mute
  await a.page.eval(`document.querySelector('.call-btn.mic').click()`);
  check(await wait(room.page, `window.__room.summary().some((x) => x.muted)`, 5000), 'muting reaches the far end', await roomCalls());
  check(await wait(a.page, `window.__callSounds.some((s) => s.name === 'mute')`, 3000), 'the mute sound plays');
  check(await wait(b.page, `window.__activeCall.value.participants.some((p) => p.id === ${JSON.stringify(selfOf(MAIN))} && p.muted)`, 5000), 'the second device sees the first muted');
  await a.page.eval(`document.querySelector('.call-btn.mic').click()`);
  check(await wait(room.page, `!window.__room.summary().some((x) => x.muted)`, 5000), 'unmuting reaches the far end');

  // ------------------------------------------------------------ camera
  await press(a.page, 'call camera');
  check(await wait(room.page, `window.__room.summary().some((x) => x.camera && x.camera.n > 30)`, 15_000), 'the device\'s camera reaches the far end', await roomCalls());
  check(await wait(b.page, `[...document.querySelectorAll('.call-video[data-video-slot]')].some((f) => f.querySelector('video').videoWidth > 0 && new RegExp(${JSON.stringify(mainName)}).test(f.textContent))`, 15_000), 'the second device sees the first\'s camera', await b.page.eval(`[...document.querySelectorAll('.call-video')].map((f) => f.textContent)`));
  check(await wait(a.page, `!!document.querySelector('.call-video.mirror video')`, 3000), 'the device shows its own camera, mirrored');
  check(await wait(a.page, `window.__callSounds.some((s) => s.name === 'camera_on')`, 3000), 'the camera sound plays');

  // ------------------------------------------------------------ screen
  await press(a.page, 'call screen');
  const shared = await wait(room.page, `window.__room.summary().some((x) => x.screen && x.screen.n > 30)`, 15_000);
  check(shared, 'the device\'s screen reaches the far end', await roomCalls());
  if (shared) {
    await b.page.eval(`document.querySelector('.call-dock-title').click()`);
    const watchable = await wait(b.page, `!!document.querySelector('[data-track="watch stream"]')`, 10_000);
    check(watchable, 'the second device is offered Watch on the first\'s stream');
    if (watchable) {
      await b.page.eval(`[...document.querySelectorAll('.call-people li')].find((li) => new RegExp(${JSON.stringify(mainName)}).test(li.textContent))?.querySelector('[data-track="watch stream"]')?.click()`);
      check(await wait(b.page, `[...document.querySelectorAll('.call-video[data-video-slot]')].some((f) => /screen/.test(f.textContent) && new RegExp(${JSON.stringify(mainName)}).test(f.textContent) && f.querySelector('video').videoWidth > 0)`, 15_000), 'the second device watches the first\'s screen', await b.page.eval(`[...document.querySelectorAll('.call-video')].map((f) => f.textContent)`));
    }
  }
  await press(a.page, 'call screen');
  check(await wait(a.page, `!window.__activeCall.value.screen`, 3000), 'stopping the share');

  // ------------------------------------------------------------ the bot's Go Live
  await a.page.eval(`document.querySelector('.call-dock-title').click()`);
  await wait(a.page, `!!document.querySelector('[data-track="watch stream"]')`, 10_000);
  await a.page.eval(`[...document.querySelectorAll('.call-people li')].find((li) => /Lev/.test(li.textContent))?.querySelector('[data-track="watch stream"]')?.click()`);
  check(await wait(a.page, `[...document.querySelectorAll('.call-video[data-video-slot]')].some((f) => /Lev · screen/.test(f.textContent) && f.querySelector('video').videoWidth > 0)`, 15_000), 'watching the bot\'s Go Live', await a.page.eval(`[...document.querySelectorAll('.call-video')].map((f) => f.textContent)`));
  const stats = await call(a.page, 'c.stats');
  check(stats?.videoIn?.fps > 5, 'video arrives at a usable rate', stats?.videoIn);

  // ------------------------------------------------------------ leaving
  await b.page.eval(`document.querySelector('.call-btn.leave').click()`);
  check(await wait(a.page, `window.__callSounds.some((s) => s.name === 'user_leave')`, 8000), 'someone leaving plays the leave sound', await sounds(a.page));
  await press(a.page, 'call camera');
  await a.page.eval(`document.querySelector('.call-btn.leave').click()`);
  check(await wait(a.page, `window.__activeCall.value === null || window.__activeCall.value.phase === 'ended'`, 5000), 'leaving ends the call');
  check(await wait(room.page, `window.__room.summary().length === 0`, 8000), 'the far end lets go of both calls', await roomCalls());

  // ------------------------------------------------------------ no microphone
  await device(c.page, MAIN);
  await c.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(c.page, `!!document.querySelector('[data-call-connected]')`, 20_000), 'a device with no microphone still joins');
  check(await call(c.page, 'c && c.listenOnly && c.muted'), 'listening only, muted', await call(c.page, 'c && { listenOnly: c.listenOnly, muted: c.muted, note: c.note }'));
  await c.page.eval(`document.querySelector('.call-btn.leave').click()`);

  for (const [n, x] of [['first device', a], ['second device', b], ['no-microphone device', c]] as const) check(x.page.errors.length === 0, `no page errors on the ${n}`, x.page.errors.slice(0, 3));
} finally {
  for (const x of browsers) await x.close().catch(() => {});
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
