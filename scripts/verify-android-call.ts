/**
 * Calls on the Android app, end to end on an emulator (docs/android.md "Testing calls"): the app's own WebView, its
 * call service and Android's permission prompts, against a demo hub whose call room plays the far end. What a phone
 * did and a browser test never sees:
 *
 * - the first call on a fresh install, which asks for the microphone (and notifications) while it starts: allowed, the
 *   call goes live, the app is never restarted, and the call service runs with the microphone;
 * - the call goes on with the app in the background and the screen off;
 * - the call's notification is up with its buttons, and leaving stops the service and ends the call everywhere;
 * - the microphone refused: listening only, still no crash, the service without the microphone type;
 * - no FATAL EXCEPTION or ANR for the app in logcat, and no crash report waiting in the app.
 *
 *   bun packages/hub/src/main.ts --demo --data <temp dir> --port <port> --web packages/web/dist
 *   (cd apps/android && ./gradlew assembleDebug)       # a debug build: applicationId ends in .verify
 *   bun scripts/verify-android-call.ts http://127.0.0.1:<port> [--serial emulator-5580] [--apk <path>] [--shots <dir>]
 *
 * The emulator must be booted already (docs/android.md has the command). The app under test is the debug build's own
 * package (org.libdither.chat.verify), so an installed release build is never touched; its data is cleared each run.
 * `--account` and `--conversation` point it at another account that makes calls (a lab hub's), with that hub's own
 * far end instead of the demo call room.
 */
import { androidDevice, TYPE_MICROPHONE, TYPE_PHONE_CALL } from './android-device.ts';
import { distributors, testPush } from './android-testpush.ts';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const hub = (args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) ?? 'http://127.0.0.1:8579').replace(/\/$/, '');
const serial = opt('serial', process.env.ANDROID_SERIAL ?? 'emulator-5580')!;
const apk = opt('apk', 'apps/android/app/build/outputs/apk/debug/app-debug.apk')!;
const PKG = opt('package', 'org.libdither.chat.verify')!;
/** apps/android/uitest's outputs: `./gradlew :uitest:assembleDebug :uitest:assembleDebugAndroidTest`. */
const UITEST = opt('uitest', 'apps/android/uitest/build/outputs/apk')!;
/** apps/android/testpush's APK (`./gradlew :testpush:assembleDebug`): the distributor where the device has none. */
const TESTPUSH = opt('testpush', 'apps/android/testpush/build/outputs/apk/debug/testpush-debug.apk')!;
const ADB = opt('adb', process.env.ADB ?? (Bun.which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`))!;
const ACCOUNT = opt('account', 'acc_demo-discord-main')!;
/** `--only calls` or `--only rings`: one part of the run. */
const ONLY = opt('only');
/** `--shots <dir>`: screenshots of the ring (as it comes, in the shade) and of the answered call, for a PR. */
const SHOTS = opt('shots');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
  return !!ok;
};

// ---------------------------------------------------------------- the device

const phone = androidDevice({ serial, pkg: PKG, hub, adb: ADB });
const { adb, sh, pid, deaths, callService, prompt, answerPrompts, attach, page, until, waitFor, poll, pressInShade, closeShade, notification, freshApp } = phone;

/** Rings the demo account in a chat (the demo's `ring` action, as a network's call would); returns the hub's call id. */
async function ring(native: string, caller: string): Promise<string> {
  const r = (await fetch(`${hub}/api/accounts/${ACCOUNT}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ring', args: { conversation: native, caller } }) }).then((x) => x.json())) as any;
  if (!r.ok) throw new Error(`ring: ${JSON.stringify(r)}`);
  let id = '';
  await waitFor(async () => {
    const calls = ((await fetch(`${hub}/api/calls/ringing`).then((x) => x.json())) as any).calls as any[];
    id = calls.find((c) => c.ringing && c.accountId === ACCOUNT)?.id ?? '';
    return !!id;
  }, 5000);
  if (!id) throw new Error('the hub never had the ring');
  return id;
}
const hubCall = async (id: string) => (((await fetch(`${hub}/api/calls/ringing`).then((x) => x.json())) as any).calls as any[]).find((c) => c.id === id) ?? null;

/** A screenshot of the emulator's screen into SHOTS, when asked for. */
function shot(name: string) {
  if (!SHOTS) return;
  const r = Bun.spawnSync([ADB, '-s', serial, 'exec-out', 'screencap', '-p'], { stdout: 'pipe' });
  Bun.write(`${SHOTS}/${name}.png`, r.stdout);
}

const callNow = () => page<any>(`(() => { const c = window.__activeCall?.value; return c ? { phase: c.phase, conversationId: c.conversationId, listenOnly: !!c.listenOnly, muted: c.muted, timing: c.timing, note: c.note ?? null } : null; })()`);

/** The voice channel open in the app, in bridge mode as the account; throws with what the page shows instead. */
async function openVoice(conversation: string) {
  // A cold app on a just-booted emulator takes a while to draw its first layout.
  const drawn = await until(`document.querySelector('#app > .app')`, 60_000);
  if (drawn) {
    await page(`(localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), callMode: 'bridge', sendAs: { ${JSON.stringify(conversation)}: ${JSON.stringify(ACCOUNT)} } })), location.href = '/?calls=1#/inbox/c/${conversation}', true)`);
    if (await until(`location.search.includes('calls=1') && document.querySelector('.call-join')`, 45_000)) return true;
  }
  const seen = await page(`({ href: location.href.replace(location.origin, ''), ready: document.readyState, layout: !!document.querySelector('#app > .app'), text: document.body?.innerText?.slice(0, 160) })`);
  throw new Error(`the app did not open the voice channel (${drawn ? 'no Join button' : 'never drew its layout'}): ${JSON.stringify(seen)}`);
}

// ---------------------------------------------------------------- the run

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
const demo = boot.accounts.every((a: any) => a.demo);
const conversation =
  opt('conversation') ?? boot.conversations.find((c: any) => c.variant === 'voice' && c.vantages.some((v: any) => v.accountId === ACCOUNT))?.id;
if (!conversation) throw new Error(`no voice conversation for ${ACCOUNT}: pass --conversation`);

/** The test's distributor and push server, where the device has no distributor of its own (rings()). */
type TestPush = Awaited<ReturnType<typeof testPush>>;
let testpush: TestPush | null = null;

const room = demo ? await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }) : null;
const roomCalls = async () => (room ? ((await room.page.eval<any[]>(`window.__room.summary()`)) ?? []) : []);

try {
  if (room) {
    await room.page.goto(`${hub}/demo/callroom.html`);
    check(await room.page.until(`/Open/.test(document.getElementById('status').textContent)`, 15_000).then(() => true, () => false), 'the demo call room connects to the hub');
  }
  adb('install', '-r', apk);
  // The button presser (apps/android/uitest): its app and the test APK that instruments it.
  for (const u of [`${UITEST}/debug/uitest-debug.apk`, `${UITEST}/androidTest/debug/uitest-debug-androidTest.apk`]) adb('install', '-r', '-t', u);
  adb('logcat', '-c');

  if (ONLY !== 'rings') await calls();
  if (ONLY !== 'calls') {
    if (demo) await rings();
    else console.log('skip rings: they need a demo hub, whose accounts ring when told to');
  }

  // ------------------------------------------------------------ nothing died
  const dead = deaths();
  check(dead.length === 0, 'no crash or ANR of the app in logcat', dead.slice(0, 3));
  const waiting = sh(`run-as ${PKG} cat files/crashes.json 2>/dev/null || true`).trim();
  check(!waiting || waiting === '[]', 'no crash report waiting in the app', waiting.slice(0, 300));
} finally {
  await room?.close().catch(() => {});
  // Set inside rings(), which the compiler does not follow from here.
  await (testpush as TestPush | null)?.stop().catch(() => {});
  try {
    closeShade();
    sh(`am force-stop ${PKG}`);
    if (phone.cdpPort) adb('forward', '--remove', `tcp:${phone.cdpPort}`);
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

async function calls() {
  // ------------------------------------------------------------ first call, fresh install: the prompts come mid-start
  await freshApp();
  check(await openVoice(conversation), 'the app opens the voice channel');
  const before = pid();
  await page(`(document.querySelector('.call-join').click(), true)`);
  const prompts = await answerPrompts(['RECORD_AUDIO', 'POST_NOTIFICATIONS'], ['RECORD_AUDIO', 'POST_NOTIFICATIONS']);
  check(prompts[0] === 'RECORD_AUDIO', 'Android asks for the microphone first, as the call starts', prompts);
  check(prompts.includes('POST_NOTIFICATIONS'), 'and for notifications once it is live', prompts);
  check(pid() === before, 'the app was not restarted while the call started', { before, after: pid() });
  check(await until(`window.__activeCall?.value?.phase === 'live'`, 20_000), 'the call goes live', await callNow());
  const c1 = await callNow();
  check(c1 && !c1.listenOnly, 'with the microphone (not listening only)', c1);
  if (room) check((await roomCalls()).length === 1, 'the far end has the call', await roomCalls());
  check(await until(`window.__activeCall?.value?.timing?.firstAudio !== undefined`, 15_000), 'the app hears the call', (await callNow())?.timing);
  let svc = callService();
  check(svc.running && svc.foreground, 'the call service runs in the foreground', svc);
  check((svc.types & TYPE_MICROPHONE) !== 0 && (svc.types & TYPE_PHONE_CALL) !== 0, 'as a phone call, with the microphone', svc);

  // ------------------------------------------------------------ in the background, screen off
  sh('input keyevent KEYCODE_HOME');
  await waitFor(() => !sh('dumpsys activity activities | grep -m1 topResumedActivity || true').includes(PKG), 5000);
  sh('input keyevent KEYCODE_SLEEP');
  // What is tested here is a length of time: the call holding on through it with the screen off.
  await Bun.sleep(12_000);
  svc = callService();
  check(svc.running && svc.foreground, 'the service holds on with the app away and the screen off', svc);
  check((await callNow())?.phase === 'live', 'the call is still live', await callNow());
  if (room) check((await roomCalls()).length === 1, 'the far end still has it', await roomCalls());
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard 2>/dev/null; true');

  // The call's notification and its buttons, from dumpsys: uiautomator cannot read the shade while the page animates.
  const note = sh(`dumpsys notification --noredact | grep -A60 'pkg=${PKG} .*id=2 ' || true`);
  check(/FOREGROUND_SERVICE/.test(note) && /"Hang up"/.test(note) && /"Mute"/.test(note) && /"Audio: /.test(note), 'the call notification is up with Hang up, Mute and Audio', note.match(/\[\d\] "[^"]+"/g) ?? []);
  await page(`(document.querySelector('.call-btn.leave')?.click(), true)`);
  check(await until(`!window.__activeCall?.value || window.__activeCall.value.phase === 'ended'`, 10_000), 'leaving ends the call', await callNow());
  check(await waitFor(() => !callService().running, 5000), 'the call service stops', callService());
  if (room) check(await waitFor(async () => (await roomCalls()).length === 0, 8000), 'the far end lets go', await roomCalls());

  // ------------------------------------------------------------ the microphone refused
  await freshApp();
  await openVoice(conversation);
  const before2 = pid();
  await page(`(document.querySelector('.call-join').click(), true)`);
  // Refuses the microphone, allows notifications.
  const refused = await answerPrompts(['POST_NOTIFICATIONS'], ['RECORD_AUDIO', 'POST_NOTIFICATIONS']);
  check(refused[0] === 'RECORD_AUDIO' && refused.filter((p) => p === 'RECORD_AUDIO').length === 1, 'Android asks for the microphone once', refused);
  check(pid() === before2, 'refusing does not restart the app', { before: before2, after: pid() });
  check(await until(`window.__activeCall?.value?.phase === 'live'`, 20_000), 'the call still goes live', { call: await callNow(), refused, promptUp: prompt() });
  check((await callNow())?.listenOnly, 'listening only', await callNow());
  svc = callService();
  check(svc.running && (svc.types & TYPE_PHONE_CALL) !== 0 && (svc.types & TYPE_MICROPHONE) === 0, 'the service runs as a phone call, without the microphone', svc);

  const note2 = sh(`dumpsys notification --noredact | grep -A60 'pkg=${PKG} .*id=2 ' || true`);
  check(/"Hang up"/.test(note2), 'its notification is up with Hang up', note2.match(/\[\d\] "[^"]+"/g) ?? []);
  await page(`(document.querySelector('.call-btn.leave')?.click(), true)`);
  check(await until(`!window.__activeCall?.value || window.__activeCall.value.phase === 'ended'`, 10_000), 'leaving ends it', await callNow());
  check(await waitFor(() => !callService().running, 5000), 'the call service stops', callService());
  if (room) check(await waitFor(async () => (await roomCalls()).length === 0, 8000), 'the far end lets go', await roomCalls());

}

/**
 * A call ringing the app's account (docs/calls.md "Ringing"), through real push: the app registered with the hub through
 * the emulator's UnifiedPush distributor, or, where it has none, the test's own (android-testpush.ts). The ring rings
 * with Answer and Decline; Decline declines it on the network; Answer opens the app and joins, with the app open in the
 * background and with its process gone; and a ring the caller gives up is taken back.
 */
async function rings() {
  const dm = boot.conversations.find((c: any) => c.shape === 'direct' && c.vantages.some((v: any) => v.accountId === ACCOUNT));
  const peer = boot.identities.find((i: any) => dm.participantIds.includes(i.id) && !boot.accounts.some((a: any) => a.selfIdentityId === i.id));
  if (!dm || !peer) throw new Error('no direct chat with someone for the account to be rung in');
  const devicesNow = async () => ((await fetch(`${hub}/api/push`).then((r) => r.json())) as any).devices.length as number;

  // The device's own distributor where it has one (ntfy, on a local emulator), else the test's. Never both: with two,
  // the app would ask which to use. A test distributor left by a run that died is taken off first.
  if (distributors(sh).some((p) => p === 'org.libdither.chat.testpush')) adb('uninstall', 'org.libdither.chat.testpush');
  const own = distributors(sh);
  if (!own.length) testpush = await testPush({ adb: [ADB, '-s', serial], apk: TESTPUSH });
  console.log(`     push through ${own.length ? own.join(', ') : `the test's distributor, its server at ${testpush!.url}`}`);

  await freshApp();
  sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
  sh(`pm grant ${PKG} android.permission.RECORD_AUDIO`);
  await until(`document.querySelector('#app > .app')`, 60_000);
  if (testpush && !check(await testpush.approve(page), "the hub is allowed to send to the test's push server", testpush.url)) return;
  const had = await devicesNow();
  const vapid = ((await fetch(`${hub}/api/push`).then((r) => r.json())) as any).publicKey;
  await page(`(window.DitherAndroid.postMessage(JSON.stringify({ t: 'push.register', vapid: ${JSON.stringify(vapid)} })), true)`);
  if (!check(await waitFor(async () => (await devicesNow()) > had, 30_000), 'the app registers for push through the distributor')) return;
  // ntfy must hold its connection before a message for the new topic is taken (it answers 507 until then). The test's
  // distributor takes one at once.
  if (!testpush) await Bun.sleep(3000);

  // ------------------------------------------------------------ Decline, the app in the background
  sh('input keyevent KEYCODE_HOME');
  await waitFor(() => !sh('dumpsys activity activities | grep -m1 topResumedActivity || true').includes(PKG), 5000);
  let id = await ring(dm.nativeId, peer.nativeId);
  const n = await poll(() => notification(`call:${id}`), 15_000);
  check(n, 'a ring comes up as a notification of its own', n ?? { pushes: testpush?.seen });
  if (SHOTS) {
    await Bun.sleep(1000);
    shot('ring');
    sh('cmd statusbar expand-notifications');
    await Bun.sleep(1500);
    shot('ring-shade');
    sh('cmd statusbar collapse');
  }
  check(n?.channel === 'rings' && n?.category === 'call', 'on the ringing channel, as a call', n);
  check(n?.actions.includes('Answer') && n?.actions.includes('Decline'), 'with Answer and Decline', n?.actions);
  check(n?.insistent, 'ringing until it is handled', n);
  check(n?.style === 'CallStyle' && n?.fullScreen, "as Android's call notification, which can light the screen", n);
  check(pressInShade('Decline'), 'Decline is in the shade and pressed');
  closeShade();
  check(await waitFor(async () => (await hubCall(id))?.outcome === 'declined', 8000), 'the call is declined on the network', await hubCall(id));
  check(await waitFor(() => !notification(`call:${id}`), 5000), 'and the ring is gone from the phone');

  // ------------------------------------------------------------ the caller gives up
  id = await ring(dm.nativeId, peer.nativeId);
  check(await waitFor(() => !!notification(`call:${id}`), 15_000), 'a second ring comes up');
  await fetch(`${hub}/api/accounts/${ACCOUNT}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'ringStop', args: { conversation: dm.nativeId } }) });
  check(await waitFor(() => !notification(`call:${id}`), 15_000), 'a ring the caller gives up is taken back', notification(`call:${id}`));
  check((await hubCall(id))?.outcome === 'missed', 'as missed', await hubCall(id));

  // ------------------------------------------------------------ Answer, the app in the background
  id = await ring(dm.nativeId, peer.nativeId);
  check(await waitFor(() => !!notification(`call:${id}`), 15_000), 'a third ring comes up');
  check(pressInShade('Answer'), 'Answer is pressed');
  closeShade();
  check(await waitFor(() => sh('dumpsys activity activities | grep -m1 topResumedActivity || true').includes(PKG), 8000), 'Answer brings the app up');
  check(await until(`window.__activeCall?.value?.phase === 'live' && window.__activeCall.value.conversationId === ${JSON.stringify(dm.id)}`, 20_000), 'and joins the call in that chat', await callNow());
  check(await waitFor(async () => (await hubCall(id))?.state === 'ongoing', 8000), 'the network has it answered', await hubCall(id));
  check(!notification(`call:${id}`), 'the ring is gone');
  if (SHOTS) await Bun.sleep(1500), shot('answered');
  if (room) check((await roomCalls()).length === 1, 'the far end has the call', await roomCalls());
  await pressCallButton('Mute');
  if (room) check(await waitFor(async () => (await roomCalls())[0]?.muted === true, 5000), 'the far end hears the mute', await roomCalls());
  await pressCallButton('Hang up');

  // ------------------------------------------------------------ Answer with the app's process gone: push starts it
  sh(`am force-stop ${PKG}`);
  // A force-stopped app gets no broadcasts until it is started again; a process the system killed does. Kill it as
  // Android's low-memory killer would: start it, put it away, and end its process with a signal (`am kill` only ends
  // a process Android already counts as in the background, which takes a moment after Home).
  sh(`am start -W -n ${PKG}/org.libdither.chat.MainActivity >/dev/null`);
  sh('input keyevent KEYCODE_HOME');
  await waitFor(() => !sh('dumpsys activity activities | grep -m1 topResumedActivity || true').includes(PKG), 5000);
  const was = pid();
  if (was) sh(`run-as ${PKG} kill -9 ${was} || true`);
  check(await waitFor(() => !pid(), 5000), 'the app\'s process is gone', pid());
  id = await ring(dm.nativeId, peer.nativeId);
  check(await waitFor(() => !!notification(`call:${id}`), 20_000), 'a ring reaches the app with its process gone');
  check(pressInShade('Answer'), 'Answer is pressed');
  closeShade();
  await attach();
  check(await until(`window.__activeCall?.value?.phase === 'live' && window.__activeCall.value.conversationId === ${JSON.stringify(dm.id)}`, 40_000), 'a cold start joins the call', await callNow());
  check(await waitFor(async () => (await hubCall(id))?.state === 'ongoing', 8000), 'the network has it answered', await hubCall(id));
  await pressCallButton('Hang up');
  check(await waitFor(async () => (await hubCall(id))?.state === 'ended', 8000), 'hanging up ends the call', await hubCall(id));
}

/**
 * Presses one of the ongoing call notification's buttons in the shade (Hang up, Mute, Audio) and checks what it did.
 * The page must be away for the shade to be readable, so the app goes to the background first.
 */
async function pressCallButton(which: 'Hang up' | 'Mute') {
  sh('input keyevent KEYCODE_HOME');
  await waitFor(() => !sh('dumpsys activity activities | grep -m1 topResumedActivity || true').includes(PKG), 5000);
  check(pressInShade(which), `the call notification's ${which} is pressed in the shade`);
  closeShade();
  if (which === 'Hang up') {
    check(await until(`!window.__activeCall?.value || window.__activeCall.value.phase === 'ended'`, 10_000), 'Hang up ends the call', await callNow());
    check(await waitFor(() => !callService().running, 5000), 'the call service stops', callService());
  } else check(await until(`window.__activeCall?.value?.muted === true`, 5000), 'Mute mutes the call', await callNow());
}
