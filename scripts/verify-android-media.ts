/**
 * Playing in the background on the Android app, on an emulator (docs/android.md "Playing in the background"): a sound
 * the page plays starts the app's media service, goes on with the app in the background and the screen off, answers
 * the system's controls (a headset's or the lock screen's pause and play, through the media session), and the service
 * goes when it ends or at Close; a video, which the WebView pauses with the app hidden, takes its notification with it.
 *
 *   bun packages/hub/src/main.ts --demo --data <temp dir> --port <port> --web packages/web/dist
 *   (cd apps/android && ./gradlew assembleDebug)       # a debug build: applicationId ends in .verify
 *   bun scripts/verify-android-media.ts http://127.0.0.1:<port> [--serial emulator-5580] [--apk <path>]
 *
 * The emulator must be booted already. The sound is made in the page (a minute of a quiet tone, in a message row of
 * its own), so the test needs nothing of the demo world's messages; the page's tracker (nowplaying.ts) hears it as it
 * would a voice message.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidDevice } from './android-device.ts';

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
const ADB = opt('adb', process.env.ADB ?? (Bun.which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`))!;
const SERVICE = 'org.libdither.chat.MediaService';
const TYPE_MEDIA_PLAYBACK = 0x2;

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
  return !!ok;
};

const phone = androidDevice({ serial, pkg: PKG, hub, adb: ADB });
const { adb, sh, pid, deaths, page, until, waitFor, pressInShade, closeShade, freshApp } = phone;

/** The media service as ActivityManager has it. */
function service(): { running: boolean; foreground: boolean; types: number } {
  const all = sh(`dumpsys activity services ${PKG}/${SERVICE}`);
  const at = all.search(/\* ServiceRecord\{/);
  if (at < 0) return { running: false, foreground: false, types: 0 };
  const d = all.slice(at);
  const t = d.match(/foregroundServiceType=0x([0-9a-f]+)/i) ?? d.match(/types=0x([0-9a-f]+)/i);
  return { running: true, foreground: /isForeground=true/.test(d), types: t ? parseInt(t[1], 16) : 0 };
}

/** The app's media session as Android has it: its playback state (3 playing, 2 paused), or null. */
function session(): number | null {
  const all = sh('dumpsys media_session');
  const at = all.indexOf(`package=${PKG}`);
  if (at < 0) return null;
  const st = all.slice(at, at + 3000).match(/state=PlaybackState \{state=(?:\w+\()?(\d+)/);
  return st ? Number(st[1]) : null;
}

/** Where the page's player is, in seconds, and whether it plays. */
const where = () => page<{ t: number; paused: boolean } | null>(`(() => { const a = document.querySelector('#m-verify-media audio'); return a ? { t: a.currentTime, paused: a.paused } : null })()`);

/** A minute of a quiet 440 Hz tone, as a WAV, put in a message row of its own and played. */
const PLAY = `(async () => {
  const rate = 8000, n = rate * 60, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const s = (o, x) => [...x].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 800, true);
  document.getElementById('m-verify-media')?.remove();
  const row = document.createElement('div');
  row.id = 'm-verify-media';
  row.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden';
  const a = document.createElement('audio');
  a.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  row.append(a);
  document.body.append(row);
  a.play().catch((e) => (row.dataset.error = String(e)));
  return true;
})()`;

async function main() {
  console.log(`installing ${apk}`);
  adb('install', '-r', '-t', apk);
  // The button presser (apps/android/uitest): its app and the test APK that instruments it.
  for (const u of [`${UITEST}/debug/uitest-debug.apk`, `${UITEST}/androidTest/debug/uitest-debug-androidTest.apk`]) adb('install', '-r', '-t', u);
  adb('logcat', '-c');
  await freshApp();
  // The page's own script is running once it says it drew its content (android.ts reportContent, logged by the app).
  check(await waitFor(() => /DitherStartup: content/.test(adb('logcat', '-d', '-s', 'DitherStartup:I')), 60_000), 'the app shows the hub');

  // ------------------------------------------------------------ playing starts the service
  check(await page(PLAY), 'the page makes a sound');
  check(await until(`(() => { const a = document.querySelector('#m-verify-media audio'); return a && !a.paused && a.currentTime > 0 })()`, 15_000), 'and plays it', await page(`document.getElementById('m-verify-media')?.dataset.error ?? ''`));
  check(await waitFor(() => service().foreground, 10_000), 'the media service runs in the foreground', service());
  check((service().types & TYPE_MEDIA_PLAYBACK) !== 0, 'as mediaPlayback', service().types.toString(16));
  check(/channel=playing/.test(sh(`dumpsys notification --noredact | grep -A30 'pkg=${PKG} ' || true`)), 'its notification is on the "playing" channel');
  check(await waitFor(() => session() === 3, 10_000), 'the media session says playing', session());

  // ------------------------------------------------------------ in the background with the screen off
  sh('input keyevent KEYCODE_HOME');
  sh('input keyevent KEYCODE_SLEEP');
  const before = (await where())?.t ?? 0;
  await Bun.sleep(30_000);
  const after = await where();
  check(after && !after.paused && after.t - before > 20, 'it plays on for 30 s in the background with the screen off', { before, after });
  check(!!pid(), 'the app is still there');

  // ------------------------------------------------------------ the system's controls
  sh('cmd media_session dispatch pause');
  check(await until(`document.querySelector('#m-verify-media audio')?.paused`, 10_000), 'a headset pause pauses the page');
  check(await waitFor(() => session() === 2, 10_000), 'the media session says paused', session());
  check(service().foreground, 'the service stays while paused, so play needs no new start from the background');
  sh('cmd media_session dispatch play');
  check(await until(`!document.querySelector('#m-verify-media audio')?.paused`, 10_000), 'a headset play plays it again, still in the background');

  // ------------------------------------------------------------ Close, and the end
  sh('input keyevent KEYCODE_WAKEUP');
  sh('wm dismiss-keyguard');
  check(pressInShade('Close'), 'the media controls have Close');
  closeShade();
  check(await waitFor(() => !service().running, 10_000), 'Close stops the service');
  check(await until(`document.querySelector('#m-verify-media audio')?.paused`, 10_000), 'and pauses the page');

  sh(`am start -W -n ${PKG}/org.libdither.chat.MainActivity >/dev/null`);
  await page(`(() => { const a = document.querySelector('#m-verify-media audio'); a.currentTime = a.duration - 1; return a.play().then(() => true) })()`);
  check(await waitFor(() => service().running, 10_000), 'playing again starts it again');
  check(await waitFor(() => !service().running, 15_000), 'the end of the sound stops it');

  // ------------------------------------------------------------ a video
  // The WebView pauses a video once the app is hidden and plays none while it is: the notification goes rather than
  // offer a Play that does nothing. Sound files and voice messages are what play on.
  sh(`am start -W -n ${PKG}/org.libdither.chat.MainActivity >/dev/null`);
  const clip = Buffer.from(readFileSync(join(import.meta.dir, '../packages/hub/src/demo-clip.webm'))).toString('base64');
  check(await page(`(async () => {
    const row = document.createElement('div');
    row.id = 'm-verify-video';
    const v = document.createElement('video');
    v.playsInline = true;
    v.src = URL.createObjectURL(new Blob([Uint8Array.from(atob('${clip}'), (c) => c.charCodeAt(0))], { type: 'video/webm' }));
    row.append(v);
    document.body.append(row);
    await v.play();
    return true;
  })()`), 'the page plays a video');
  check(await waitFor(() => service().running, 10_000), 'which starts the service');
  sh('input keyevent KEYCODE_HOME');
  check(await until(`document.querySelector('#m-verify-video video')?.paused`, 10_000), 'the WebView pauses it with the app hidden');
  check(await waitFor(() => !service().running, 10_000), 'and the service goes with it');

  const dead = deaths();
  check(dead.length === 0, 'no crash or ANR in logcat', dead);
}

try {
  await main();
} catch (e) {
  check(false, 'the run', String(e));
} finally {
  try {
    sh('input keyevent KEYCODE_WAKEUP');
    sh(`am force-stop ${PKG}`);
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
