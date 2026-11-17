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
 *   bun scripts/verify-android-call.ts http://127.0.0.1:<port> [--serial emulator-5580] [--apk <path>]
 *
 * The emulator must be booted already (docs/android.md has the command). The app under test is the debug build's own
 * package (org.libdither.chat.verify), so an installed release build is never touched; its data is cleared each run.
 * `--account` and `--conversation` point it at another account that makes calls (a lab hub's), with that hub's own
 * far end instead of the demo call room.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const ADB = opt('adb', process.env.ADB ?? (Bun.which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`))!;
const ACCOUNT = opt('account', 'acc_demo-discord-main')!;
const hubPort = new URL(hub).port || '80';

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
  return !!ok;
};

// ---------------------------------------------------------------- adb

function adb(...cmd: string[]): string {
  const r = Bun.spawnSync([ADB, '-s', serial, ...cmd], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`adb ${cmd.join(' ')}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  return r.stdout.toString();
}
const sh = (cmd: string) => adb('shell', cmd);
const pid = () => sh(`pidof ${PKG} || true`).trim();

/** Logcat lines that say the app died or hung. */
function deaths(): string[] {
  const log = adb('logcat', '-d', '-v', 'brief', '*:E', 'ActivityManager:W');
  const lines = log.split('\n');
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (/FATAL EXCEPTION/.test(l) && lines.slice(i, i + 3).some((x) => x.includes(PKG))) out.push(lines.slice(i, i + 6).join(' | '));
    if (new RegExp(`ANR in ${PKG.replace(/\./g, '\\.')}`).test(l)) out.push(l);
  });
  return out;
}

/** The call service as ActivityManager has it: running, in the foreground, and its types (ServiceInfo bits). */
function callService(): { running: boolean; foreground: boolean; types: number } {
  // Only the running record ("* ServiceRecord"), never the "Last ANR service" one, which stays after the process.
  const all = sh(`dumpsys activity services ${PKG}/org.libdither.chat.CallService`);
  const at = all.search(/\* ServiceRecord\{/);
  if (at < 0) return { running: false, foreground: false, types: 0 };
  const d = all.slice(at);
  const fg = /isForeground=true/.test(d);
  const t = d.match(/foregroundServiceType=0x([0-9a-f]+)/i) ?? d.match(/types=0x([0-9a-f]+)/i);
  return { running: true, foreground: fg, types: t ? parseInt(t[1], 16) : 0 };
}
const TYPE_PHONE_CALL = 0x4;
const TYPE_MICROPHONE = 0x80;

/** Android's permission prompt is on top: which permission it asks for, or null. */
function prompt(): string | null {
  const top = sh('dumpsys activity activities | grep -m1 topResumedActivity || true');
  return /GrantPermissionsActivity/.test(top) ? top.trim() : null;
}

/**
 * Answers Android's permission prompts until each of `expect` has been asked for, then for 2 s more to catch one asked
 * twice; returns what each prompt was for, in order. Not by tapping: uiautomator cannot read a screen while the page
 * animates, so "Allow" is the grant made from here while the prompt is up and then Back, which closes it with that
 * answer (the app reads the permission as it stands), and "Don't allow" is Back alone. `allow`: the permissions to
 * allow; the rest are refused. The prompts still come in the middle of the call's start, the case that took the app down.
 */
async function answerPrompts(allow: string[], expect: string[], maxMs = 40_000): Promise<string[]> {
  const asked: string[] = [];
  const end = Date.now() + maxMs;
  let doneAt = 0;
  while (Date.now() < end && !(doneAt && Date.now() - doneAt > 2000)) {
    if (prompt()) {
      // What this prompt is for: the app logs each request as it makes it, one at a time (MainActivity.ask).
      const which = [...adb('logcat', '-d', '-s', 'DitherStartup:I').matchAll(/asking for (.+)/g)].pop()?.[1]?.trim().split(', ').map((p) => p.replace('android.permission.', '')) ?? [];
      for (const p of which) if (allow.includes(p)) sh(`pm grant ${PKG} android.permission.${p}`);
      sh('input keyevent KEYCODE_BACK');
      asked.push(which.join('+') || 'unknown');
      for (let i = 0; i < 20 && prompt(); i++) await Bun.sleep(150);
    } else await Bun.sleep(300);
    if (!doneAt && expect.every((e) => asked.includes(e))) doneAt = Date.now();
  }
  return asked;
}

// ---------------------------------------------------------------- the app's page over DevTools

let cdpPort = 0;
async function attach(): Promise<void> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const p = pid();
    const sock = p && sh('cat /proc/net/unix').match(new RegExp(`webview_devtools_remote_${p}\\b`))?.[0];
    if (sock) {
      if (cdpPort) Bun.spawnSync([ADB, '-s', serial, 'forward', '--remove', `tcp:${cdpPort}`]);
      cdpPort = Number(adb('forward', 'tcp:0', `localabstract:${sock}`).trim());
      const list = (await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json()).catch(() => [])) as any[];
      if (list.some((t) => t.type === 'page' && t.url.startsWith(hub))) return;
    }
    await Bun.sleep(500);
  }
  throw new Error('the app\'s WebView never showed the hub (is this a debug build, pointed at the hub?)');
}

/** One expression in the app's page; null when the page is gone (the app died). */
async function page<T = any>(expr: string): Promise<T | null> {
  try {
    const list = (await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json())) as any[];
    const t = list.find((x) => x.type === 'page' && x.url.startsWith(hub));
    if (!t) return null;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    const out = await new Promise<any>((res) => {
      const timer = setTimeout(() => res({ timeout: true }), 15_000);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== 1) return;
        clearTimeout(timer);
        res(m.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
    });
    ws.close();
    if (out?.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'exception');
    return (out?.result?.value ?? null) as T | null;
  } catch (e) {
    if (/exception/.test(String(e))) throw e;
    return null;
  }
}
async function until(expr: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page<boolean>(`!!(${expr})`).catch(() => false)) return true;
    await Bun.sleep(300);
  }
  return false;
}
/** Polls a check on the host side (adb, the call room) until it holds. */
async function waitFor(fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(300);
  }
  return false;
}
const callNow = () => page<any>(`(() => { const c = window.__activeCall?.value; return c ? { phase: c.phase, listenOnly: !!c.listenOnly, muted: c.muted, timing: c.timing, note: c.note ?? null } : null; })()`);

/** A fresh start of the app: data cleared, pointed at the hub, permissions as on a fresh install. */
async function freshApp() {
  sh(`am force-stop ${PKG}`);
  sh(`pm clear ${PKG} >/dev/null`);
  for (const p of ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA', 'android.permission.POST_NOTIFICATIONS']) {
    sh(`pm revoke ${PKG} ${p} 2>/dev/null; pm clear-permission-flags ${PKG} ${p} user-set user-fixed 2>/dev/null; true`);
  }
  const prefs = join(mkdtempSync(join(tmpdir(), 'dither-android-')), 'dither.xml');
  writeFileSync(prefs, `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map><string name="hub">${hub}</string></map>\n`);
  adb('push', prefs, '/data/local/tmp/dither-verify.xml');
  sh(`run-as ${PKG} mkdir -p shared_prefs && run-as ${PKG} cp /data/local/tmp/dither-verify.xml shared_prefs/dither.xml`);
  adb('reverse', `tcp:${hubPort}`, `tcp:${hubPort}`);
  sh(`am start -W -n ${PKG}/org.libdither.chat.MainActivity >/dev/null`);
  await attach();
}

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

const room = demo ? await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }) : null;
const roomCalls = async () => (room ? ((await room.page.eval<any[]>(`window.__room.summary()`)) ?? []) : []);

try {
  if (room) {
    await room.page.goto(`${hub}/demo/callroom.html`);
    check(await room.page.until(`/Open/.test(document.getElementById('status').textContent)`, 15_000).then(() => true, () => false), 'the demo call room connects to the hub');
  }
  adb('install', '-r', apk);
  adb('logcat', '-c');

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

  // ------------------------------------------------------------ nothing died
  const dead = deaths();
  check(dead.length === 0, 'no crash or ANR of the app in logcat', dead.slice(0, 3));
  const waiting = sh(`run-as ${PKG} cat files/crashes.json 2>/dev/null || true`).trim();
  check(!waiting || waiting === '[]', 'no crash report waiting in the app', waiting.slice(0, 300));
} finally {
  await room?.close().catch(() => {});
  try {
    sh(`am force-stop ${PKG}`);
    if (cdpPort) adb('forward', '--remove', `tcp:${cdpPort}`);
  } catch {}
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
