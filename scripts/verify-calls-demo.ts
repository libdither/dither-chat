/**
 * Calls end to end on a demo hub (docs/calls.md "Demo calls"): two devices in headless Chromium, as the demo's two
 * Discord accounts, in the libdither server's voice channel, and the demo call room in a third browser as the far end
 * of both. Checks, through the app's own buttons:
 *
 * - joining: live, and connected, in good time; the join sound; the call room hears the device's microphone and the
 *   device hears the room's bot; the bot's camera shows on a video slot;
 * - a second device joining plays the join sound on the first, and each is in the other's people;
 * - the bot's speaking ring: round, and what the call says (the hold itself is unit-tested, test/callmarks.test.ts);
 * - mute and unmute reach the far end, with their sounds; talking while muted marks the mic button, without moving
 *   the dock;
 * - the first device's camera reaches the far end and shows on the second device;
 * - the first device shares its screen: the far end gets it, the second device presses Watch and sees it;
 * - watching the bot's Go Live;
 * - the second device leaving plays the leave sound on the first; leaving ends the call everywhere;
 * - a device with no microphone still joins, listening only;
 * - the call bar on a phone: shown at the top of the list and of another chat, in one place, nothing under it, not on the
 *   call's own; no Leave on it, 44 px buttons; mute from it; the row's mark is bars; a tap opens a sheet in place, back
 *   folds it, Go to chat opens the call's chat; a computer's hidden list: the bar under the page, the dock over it on a
 *   tap, Escape folds it, Leave from there;
 * - a ring on the page in front rings aloud, and stops when the caller gives up; a muted chat's ring shows quietly;
 * - no page errors.
 *
 *   bun packages/hub/src/main.ts --demo --data /tmp/x --port 8579 --web packages/web/dist
 *   bun scripts/verify-calls-demo.ts http://127.0.0.1:8579
 *
 * Use a fresh demo world each run (it joins a call; nothing in it changes otherwise).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
/**
 * Talk, as a microphone hears it: 300 ms "syllables" of a tone at about -15 dBFS with 100 ms gaps, for 4 s (Chromium
 * loops it). Chromium's own fake microphone only beeps briefly once a second, too short to count as talking.
 */
function talkWav(file: string) {
  const rate = 48_000;
  const n = rate * 4;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const on = (i / rate) % 0.4 < 0.3;
    buf.writeInt16LE(on ? Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.25 * 32767) : 0, 44 + i * 2);
  }
  writeFileSync(file, buf);
  return file;
}
const scratch = mkdtempSync(join(tmpdir(), 'calls-demo-'));
const talk = talkWav(join(scratch, 'talk.wav'));

const room = await launch({ args: MEDIA });
const a = await launch({ args: [...MEDIA, `--use-file-for-fake-audio-capture=${talk}`] });
const b = await launch({ args: MEDIA });
// No fake devices: getUserMedia finds no microphone.
const c = await launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const d = await launch({ args: MEDIA });
const browsers = [room, a, b, c, d];

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

  // ------------------------------------------------------------ who is speaking
  await a.page.eval(`document.querySelector('.call-dock-title').click()`);
  const levAv = `[...document.querySelectorAll('.call-people li')].find((li) => /Lev/.test(li.textContent))?.querySelector('.call-av')`;
  // In one look: the ring and its words come from the same render.
  check(await wait(a.page, `!!${levAv}?.dataset.speaking && /speaking/.test(${levAv}.getAttribute('aria-label'))`, 15_000), 'the bot gets the speaking ring while it talks, with words a screen reader hears');
  const box = await a.page.eval<number[]>(`(() => { const r = ${levAv}.getBoundingClientRect(); return [r.width, r.height]; })()`);
  check(box[0] === box[1] && box[0] > 0, 'the ring goes round a square box (round, not oval)', box);
  await a.page.eval(`document.querySelector('.call-dock-title').click()`);

  // ------------------------------------------------------------ the second device joins
  await device(b.page, ALT);
  await b.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(b.page, `!!document.querySelector('[data-call-connected]')`, 20_000), 'the second device joins');
  check(await wait(a.page, `window.__activeCall.value.participants.length >= 3`, 10_000), 'the first device sees the second', await call(a.page, 'c.participants.map((p) => p.id)'));
  check(await wait(a.page, `window.__callSounds.filter((s) => s.name === 'user_join').length >= 2`, 5000), 'someone joining plays the join sound', await sounds(a.page));

  // ------------------------------------------------------------ mute
  const dockHeight = `document.querySelector('.call-dock').getBoundingClientRect().height`;
  const before = await a.page.eval<number>(dockHeight);
  await a.page.eval(`document.querySelector('.call-btn.mic').click()`);
  check(await wait(room.page, `window.__room.summary().some((x) => x.muted)`, 5000), 'muting reaches the far end', await roomCalls());
  check(await wait(a.page, `window.__callSounds.some((s) => s.name === 'mute')`, 3000), 'the mute sound plays');
  check(await wait(a.page, `!!document.querySelector('.call-btn.mic.muted-talking') && !!document.querySelector('.call-mic-note')`, 8000), 'talking into a muted microphone marks the mic button');
  const muted = await a.page.eval<{ height: number; said: string }>(`({ height: ${dockHeight}, said: document.querySelector('.call-mic [aria-live]').textContent })`);
  check(muted.height === before && /muted/.test(muted.said), 'its note moves nothing, and a screen reader hears it', { before, ...muted });
  // The copy listened to while muted stays on this device: the far end hears nothing from it.
  check(await wait(room.page, `window.__room.summary().some((x) => x.muted && x.micLevel < 0.005)`, 5000), 'while muted the far end hears silence, talking or not', await roomCalls());
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

  // ------------------------------------------------------------ the call bar, on a phone
  const other = boot.conversations.find((x: any) => x.shape === 'direct' && x.vantages.some((v: any) => v.accountId === MAIN));
  const space = voice.spaceIds?.[0] as string | undefined;
  await d.page.size(390, 844, true);
  await device(d.page, MAIN);
  await d.page.eval(`document.querySelector('.call-join').click()`);
  check(await wait(d.page, `!!document.querySelector('[data-call-connected]')`, 20_000), 'the phone joins');
  const ui = () => d.page.eval<{ bar: boolean; dock: boolean; sheet: boolean; hash: string }>(`({ bar: !!document.querySelector('.call-bar'), dock: !!document.querySelector('.call-dock'), sheet: !!document.querySelector('.call-sheet'), hash: location.hash })`);
  check(await wait(d.page, `!!document.querySelector('.call-dock') && !document.querySelector('.call-bar')`, 3000), "on the call's own chat: the dock, no bar", await ui());
  await d.page.eval(`location.hash = ${JSON.stringify(space ? `#/s/${space}` : '#/inbox')}`);
  check(await wait(d.page, `!!document.querySelector('.call-bar') && !document.querySelector('.call-dock')`, 5000), 'in the list: the bar, no dock', await ui());
  /** Where the bar is, and whether the list starts below it (a row of the layout: nothing under it). */
  const place = () => d.page.eval<{ top: number; bottom: number; under: number }>(`(() => { const b = document.querySelector('.call-bar').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), under: Math.round(document.querySelector('.app > .sidebar').getBoundingClientRect().top) }; })()`);
  const inList = await place();
  check(inList.top === 0 && inList.under >= inList.bottom, 'the bar is the top of the screen, the list starting below it', inList);
  check(await d.page.eval(`!document.querySelector('.call-bar [data-track="call bar: leave"], .call-bar .call-btn.leave')`), 'the bar has no Leave');
  check(await d.page.eval(`[...document.querySelectorAll('.call-bar button')].every((x) => { const r = x.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })`), 'every button on the bar is 44 px or more');
  if (space) {
    check(await wait(d.page, `!!document.querySelector('[data-call-mark="mine"]')`, 5000), "the call's row has its mark");
    check(await d.page.eval(`!document.querySelector('[data-call-mark] .avatar') && document.querySelector('[data-call-mark="mine"]').getAttribute('role') === 'img'`), 'the mark is bars, no face, and a screen reader hears it');
  }
  const mute = `document.querySelector('.call-bar [data-track="call bar: mute"]')`;
  await d.page.eval(`${mute}.click()`);
  check(await wait(d.page, `window.__activeCall.value.muted && ${mute}.classList.contains('off') && ${mute}.getAttribute('aria-pressed') === 'true'`, 3000), 'the bar mutes (aria-pressed)');
  await d.page.eval(`${mute}.click()`);
  check(await wait(d.page, `!window.__activeCall.value.muted && ${mute}.getAttribute('aria-pressed') === 'false'`, 3000), 'and unmutes');
  if (other) {
    await d.page.eval(`location.hash = ${JSON.stringify(`#/c/${other.id}`)}`);
    check(await wait(d.page, `location.hash.includes(${JSON.stringify(other.id)}) && !!document.querySelector('.call-bar') && !document.querySelector('.call-dock')`, 5000), 'on another chat: the bar', await ui());
    const onPage = await place();
    check(onPage.top === inList.top && onPage.bottom === inList.bottom, 'in the same place as over the lists', { inList, onPage });
    check(await d.page.eval(`document.querySelector('.app > .center').getBoundingClientRect().top >= ${onPage.bottom}`), 'the page starts below it');
  }
  const pageWas = await d.page.eval<string>(`location.hash`);
  await d.page.eval(`document.querySelector('[data-track="call bar: open"]').click()`);
  check(await wait(d.page, `!!document.querySelector('.call-sheet') && document.querySelector('[data-track="call bar: open"]').getAttribute('aria-expanded') === 'true'`, 3000), 'a tap on the bar opens the sheet in place', await ui());
  check((await d.page.eval<string>(`location.hash`)) === pageWas, 'without going anywhere');
  check(await wait(d.page, `['call sheet: deafen', 'call sheet: leave'].every((t) => document.querySelector('.call-sheet [data-track="' + t + '"]'))`, 3000), 'the sheet has every button, Leave among them');
  check(await wait(d.page, `!!document.querySelector('.call-sheet .call-people')`, 5000), 'and the people in the call');
  await d.page.eval(`history.back()`);
  check(await wait(d.page, `!document.querySelector('.call-sheet') && !!document.querySelector('.call-bar')`, 3000), 'back folds the sheet', await ui());
  check(await wait(d.page, `location.hash === ${JSON.stringify(pageWas)}`, 3000), 'and stays on the page');
  await d.page.eval(`document.querySelector('[data-track="call bar: open"]').click()`);
  await wait(d.page, `!!document.querySelector('.call-sheet-go')`, 3000);
  await d.page.eval(`document.querySelector('.call-sheet-go').click()`);
  check(await wait(d.page, `location.hash.includes(${JSON.stringify(voice.id)}) && !!document.querySelector('.call-dock') && !document.querySelector('.call-bar') && !document.querySelector('.call-sheet')`, 5000), "Go to chat opens the call's chat, with the dock", await ui());
  // A computer with the list hidden (all communities): the bar in a row under the page; a tap shows the dock over it.
  await d.page.size(1280, 800, false);
  await d.page.eval(`location.hash = '#/directory'`);
  check(await wait(d.page, `!!document.querySelector('.call-bar') && !document.querySelector('.call-dock')`, 5000), "a computer's hidden list: the bar", await ui());
  check(await d.page.eval(`(() => { const b = document.querySelector('.call-bar').getBoundingClientRect(), c = document.querySelector('.app > .center').getBoundingClientRect(); return c.bottom <= b.top + 1 && Math.round(b.bottom) === innerHeight; })()`), 'under the page, not over it');
  await d.page.eval(`document.querySelector('[data-track="call bar: open"]').click()`);
  check(await wait(d.page, `!!document.querySelector('.call-dock.over-bar') && location.hash === '#/directory'`, 3000), 'a tap shows the dock over the bar, staying on the page', await ui());
  await d.page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check(await wait(d.page, `!document.querySelector('.call-dock') && !!document.querySelector('.call-bar')`, 3000), 'Escape folds it', await ui());
  await d.page.eval(`document.querySelector('[data-track="call bar: open"]').click()`);
  await wait(d.page, `!!document.querySelector('.call-dock.over-bar .call-btn.leave')`, 3000);
  await d.page.eval(`document.querySelector('.call-dock.over-bar .call-btn.leave').click()`);
  check(await wait(d.page, `window.__activeCall.value === null || window.__activeCall.value.phase === 'ended'`, 5000), 'leaving from the expanded bar ends the call');

  // ------------------------------------------------------------ a ring on the page in front
  // The service worker closes the ring's notification while a page is in front, so the page itself rings (ringtone.ts);
  // a muted chat's ring shows its card quietly.
  const dm = boot.conversations.find((x: any) => x.shape === 'direct' && x.vantages.some((v: any) => v.accountId === MAIN));
  const peer = boot.identities.find((i: any) => i.id === dm?.participantIds.find((p: string) => p !== selfOf(MAIN)));
  const act = (action: string, args: unknown) => fetch(`${hub}/api/accounts/${MAIN}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) }).then((r) => r.json());
  const rule = (level: string | null) => fetch(`${hub}/api/rules`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'conversation', target: dm.id, level }) });
  const ringState = () => a.page.eval<{ on: boolean; rings: number; blocked: boolean }>(`({ ...window.__ringtone })`);
  await act('ring', { conversation: dm.nativeId, caller: peer.nativeId });
  check(await wait(a.page, `!!document.querySelector('.ring-card') && window.__ringtone.on && window.__ringtone.rings > 0`, 10_000), 'a ring card on the page in front rings aloud', await ringState());
  await act('ringStop', { conversation: dm.nativeId });
  check(await wait(a.page, `!document.querySelector('.ring-card') && !window.__ringtone.on`, 10_000), 'and stops when the caller gives up', await ringState());
  await rule('none');
  const ringsBefore = (await ringState()).rings;
  await act('ring', { conversation: dm.nativeId, caller: peer.nativeId });
  check(await wait(a.page, `!!document.querySelector('.ring-card')`, 10_000), "a muted chat's ring still shows its card");
  check(!(await ringState()).on && (await ringState()).rings === ringsBefore, 'quietly', await ringState());
  await act('ringStop', { conversation: dm.nativeId });
  await rule(null);
  await wait(a.page, `!document.querySelector('.ring-card')`, 10_000);

  for (const [n, x] of [['first device', a], ['second device', b], ['no-microphone device', c], ['phone', d]] as const) check(x.page.errors.length === 0, `no page errors on the ${n}`, x.page.errors.slice(0, 3));
} finally {
  for (const x of browsers) await x.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
