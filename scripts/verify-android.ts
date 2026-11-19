/**
 * Every emulator test of the Android app, in one run (CI's android-device workflow, docs/testing.md "Android"):
 * verify-android-call.ts against a demo hub of its own, then verify-android-arrived.ts, which starts its own.
 *
 *   bun run web:build
 *   (cd apps/android && ./gradlew :app:assembleDebug :uitest:assembleDebug :uitest:assembleDebugAndroidTest)
 *   bun scripts/verify-android.ts [--serial emulator-5554] [--shots <dir>]
 *
 * The emulator must be booted already. Each test clears the debug build's data first, so the order does not matter.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const serial = opt('serial') ?? process.env.ANDROID_SERIAL ?? 'emulator-5554';
const shots = opt('shots');
const ADB = process.env.ADB || Bun.which('adb') || `${process.env.HOME}/Android/Sdk/platform-tools/adb`;

// Android's own "isn't responding" dialogs: the emulator's System UI is slow on a software GPU and can raise one over
// the app. They change nothing the tests read (the page over DevTools, dumpsys, logcat), but they cover screenshots.
Bun.spawnSync([ADB, '-s', serial, 'shell', 'settings put global hide_error_dialogs 1']);

const results: { name: string; ok: boolean; s: number }[] = [];
async function run(name: string, cmd: string[]) {
  const t = performance.now();
  console.log(`\n== ${name}`);
  const p = Bun.spawn(cmd, { cwd: REPO, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ANDROID_SERIAL: serial, ADB } });
  const ok = (await p.exited) === 0;
  results.push({ name, ok, s: Math.round((performance.now() - t) / 1000) });
}

// The calls test takes the hub it is given: a demo hub on a free port, with a throwaway data dir.
const data = mkdtempSync(join(tmpdir(), 'dither-android-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const hubUrl = `http://127.0.0.1:${port}`;
const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', '--web', process.env.DITHER_WEB_DIST ?? 'packages/web/dist'], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
  stdout: 'ignore',
  stderr: 'inherit',
});
try {
  const end = Date.now() + 60_000;
  while (!(await fetch(`${hubUrl}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the demo hub did not answer in 60 s');
    await Bun.sleep(200);
  }
  await run('calls and rings (verify-android-call.ts)', ['bun', 'scripts/verify-android-call.ts', hubUrl, '--serial', serial, ...(shots ? ['--shots', shots] : [])]);
} finally {
  hub.kill('SIGKILL');
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
await run("a push's copy (verify-android-arrived.ts)", ['bun', 'scripts/verify-android-arrived.ts', '--serial', serial, ...(shots ? ['--shots', shots] : [])]);

console.log('\n== summary');
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  ${r.s} s`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
