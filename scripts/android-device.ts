/**
 * Driving the Android app on an emulator for the call scripts (verify-android-call.ts, verify-call-pair.ts): adb, the
 * app's WebView page over DevTools, Android's permission prompts, the call service and notifications as dumpsys has
 * them, and the shade's buttons pressed by apps/android/uitest. The app under test is a debug build (its WebView can be
 * debugged), pointed at `hub` through `adb reverse`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TYPE_PHONE_CALL = 0x4;
export const TYPE_MICROPHONE = 0x80;

export function androidDevice(o: { serial: string; pkg: string; hub: string; adb?: string }) {
  const { serial, hub } = o;
  const PKG = o.pkg;
  const ADB = o.adb ?? (process.env.ADB || Bun.which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`);
  const hubPort = new URL(hub).port || '80';

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
  /** Polls until `fn` gives something, and gives that (null after `ms`). */
  async function poll<T>(fn: () => T | null, ms: number): Promise<T | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await Bun.sleep(300);
    }
    return null;
  }

  /**
   * Presses a button in the shade by its words, through the uitest APK (apps/android/uitest), which reads the screen
   * without waiting for it to be still and so works while a call draws; false when the button is not there.
   */
  function pressInShade(words: string, ms = 10_000): boolean {
    const out = sh(`am instrument -w -e class org.libdither.chat.uitest.Shade#press -e words '${words.replace(/'/g, '')}' -e ms ${ms} org.libdither.chat.uitest.test/androidx.test.runner.AndroidJUnitRunner 2>&1 || true`);
    const ok = /OK \(1 test\)/.test(out);
    if (!ok) console.log(`     (uitest: ${out.match(/no button[^\n]*/)?.[0] ?? out.trim().split('\n').slice(-3).join(' / ')})`);
    return ok;
  }
  const closeShade = () => sh('cmd statusbar collapse-notifications 2>/dev/null; cmd statusbar collapse 2>/dev/null; true');

  /** The app's notification with this tag, from dumpsys: its channel, category, flags and buttons, or null. */
  function notification(tag: string): { channel: string; category: string; actions: string[]; insistent: boolean; fullScreen: boolean; style: string } | null {
    const all = sh('dumpsys notification --noredact');
    const head = all.split('\n').findIndex((l) => l.includes('NotificationRecord(') && l.includes(`pkg=${PKG} `) && l.includes(` tag=${tag} `));
    if (head < 0) return null;
    const lines = all.split('\n').slice(head);
    const end = lines.findIndex((l, i) => i > 0 && l.includes('NotificationRecord('));
    const rec = lines.slice(0, end < 0 ? undefined : end).join('\n');
    return {
      channel: rec.match(/channel=(\S+)/)?.[1] ?? '',
      category: rec.match(/category=(\S+)/)?.[1] ?? '',
      actions: [...rec.matchAll(/\[\d\] "([^"]+)"/g)].map((m) => m[1]),
      insistent: /flags=\S*INSISTENT/.test(rec),
      fullScreen: /fullscreenIntent=PendingIntent/.test(rec),
      style: rec.match(/android\.template=String \(android\.app\.Notification\$(\w+)\)/)?.[1] ?? '',
    };
  }

  /** A fresh start of the app: data cleared, pointed at the hub, permissions as on a fresh install. */
  async function freshApp(login?: string) {
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
    // A hub with a password: the page signs in, as its login form would.
    if (login) {
      await page(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(login)} }) }).then((r) => r.ok && location.reload()).then(() => true)`);
      await attach();
    }
  }


  return { adb, sh, pid, deaths, callService, prompt, answerPrompts, attach, page, until, waitFor, poll, pressInShade, closeShade, notification, freshApp, serial, pkg: PKG, get cdpPort() { return cdpPort; } };
}
