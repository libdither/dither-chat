/**
 * A push's copy of its message in the Android app (docs/notifications.md, "A copy in the push"), end to end on an
 * emulator: the app keeps the copy in a file (Arrived.kt) where a browser's service worker would keep it, and hands
 * it to the page. What scripts/verify-arrived.ts checks in a browser, through the app's own path:
 *   1. the app opens online, so a snapshot is kept, and is closed;
 *   2. the hub stops, and a push about a new message in a group comes, with its copy: the notification shows and the
 *      app keeps the record;
 *   3. the app opens on that chat from the notification's intent, the hub still gone: the chat shows the message,
 *      under the line that says earlier messages may be missing, and its row in the list shows it;
 *   4. a second push while the app is open and offline: the open page shows it at once;
 *   5. the hub is back: its answer replaces both copies (it never had them), the line goes, and the app's records go;
 *   6. no crash or ANR of the app in logcat.
 * Pushes come in through the debug build's DebugPushReceiver, which takes the same path as a UnifiedPush message
 * (Push.arrived): an emulator has no distributor.
 *
 *   bun run web:build && (cd apps/android && ./gradlew assembleDebug)
 *   bun scripts/verify-android-arrived.ts [--serial emulator-5580] [--apk <path>] [--shots <dir>]
 *
 * The emulator must be booted already (docs/android.md, "Testing on an emulator"). Starts its own demo hub on a free
 * port with a throwaway data dir; the debug build's data is cleared first. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { androidDevice } from './android-device.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const opt = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const serial = opt('serial', process.env.ANDROID_SERIAL ?? 'emulator-5580')!;
const apk = opt('apk', 'apps/android/app/build/outputs/apk/debug/app-debug.apk')!;
const PKG = opt('package', 'org.libdither.chat.verify')!;
const shots = opt('shots') ? resolve(opt('shots')!) : null;
if (shots) mkdirSync(shots, { recursive: true });

const data = mkdtempSync(join(tmpdir(), 'dither-android-arrived-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

const t0 = performance.now();
const at = () => `+${((performance.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${at()} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  return !!ok;
};

let hub: ReturnType<typeof Bun.spawn> | null = null;
async function startHub() {
  hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: REPO,
    env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const end = Date.now() + 60_000;
  while (!(await fetch(`${url}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the hub did not answer in 60 s');
    await Bun.sleep(200);
  }
}
async function stopHub() {
  hub?.kill('SIGKILL');
  await hub?.exited;
  hub = null;
}

const phone = androidDevice({ serial, pkg: PKG, hub: url });
const { adb, sh, deaths, page, until, waitFor, notification, freshApp, attach } = phone;

/** The app's kept records (files/arrived.json), by key; none when the file is gone. */
const records = (): string[] => {
  const text = sh(`run-as ${PKG} cat files/arrived.json 2>/dev/null || true`).trim();
  if (!text.startsWith('[')) return [];
  return (JSON.parse(text) as { key: string }[]).map((r) => r.key);
};
/** A push, as UnifiedPush would hand it to the app: through the debug build's receiver. */
const push = (d: unknown) => {
  const out = sh(`am broadcast --include-stopped-packages -a org.libdither.chat.DEBUG_PUSH -n ${PKG}/org.libdither.chat.DebugPushReceiver --es b64 ${Buffer.from(JSON.stringify(d)).toString('base64')}`);
  if (!/Broadcast completed/.test(out)) throw new Error(`the push was not delivered: ${out.trim()}`);
};
const shown = (body: string) =>
  `[...document.querySelectorAll('.timeline-scroll .msg')].some((e) => e.textContent.includes(${JSON.stringify(body)}))`;

const BODY = 'Arrived while you were away';
const LIVE = 'And another while the app was open';

await startHub();
try {
  adb('install', '-r', apk);
  adb('logcat', '-c');

  // 1. Online: the snapshot is kept.
  await freshApp();
  sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
  const kept = `new Promise((res) => {
    const q = indexedDB.open('dither-chat');
    q.onerror = () => res(false);
    q.onsuccess = () => {
      const d = q.result;
      try {
        const a = d.transaction('snapshot', 'readonly').objectStore('snapshot').get('last');
        a.onsuccess = () => (d.close(), res(!!a.result));
        a.onerror = () => (d.close(), res(false));
      } catch { d.close(); res(false); }
    };
  })`;
  if (!check(await until(`!!navigator.serviceWorker?.controller && !!document.querySelector('.app')`, 60_000), 'online: the app opens on the hub')) throw new Error('the app never opened');
  check(await until(kept, 30_000), 'online: the snapshot is kept');
  sh(`am force-stop ${PKG}`);

  // 2. The hub gone; a push about a new message, with its copy.
  const boot = (await (await fetch(`${url}/api/bootstrap`)).json()) as { conversations: P.ConversationView[] };
  const conv = boot.conversations.filter((c) => c.shape === 'group' && c.lastMessageAt).sort((a, b) => b.lastMessageAt! - a.lastMessageAt!)[0];
  if (!conv) throw new Error('the demo world has no group with messages');
  const last = ((await (await fetch(`${url}/api/conversations/${conv.id}/messages?limit=1`)).json()) as { messages: P.MessageView[] }).messages[0];
  const payload = (id: string, body: string, unread: number) => {
    const ts = Math.max(Date.now(), (conv.lastMessageAt ?? 0) + 1);
    const message: P.MessageView = { ...last, id, nativeId: id, ts, editedTs: null, body, replyToId: null, attachments: [], embeds: [], reactions: [], deleted: false };
    const arrived: P.PushArrived = {
      message,
      lastMessage: { id, authorId: message.authorId, ts, kind: message.kind, text: body },
      lastMessageAt: ts,
      vantages: conv.vantages.map((v) => ({ ...v, unread: v.unread + unread })),
    };
    return { title: conv.name ?? 'Someone', body, tier: 'push', conversationId: conv.id, messageId: id, conv: { shape: 'group', title: conv.name ?? '' }, arrived };
  };
  await stopHub();
  push(payload('msg_verify_android_arrived', BODY, 1));
  check(await waitFor(() => !!notification(conv.id), 10_000), 'the hub gone, a push with its copy: its notification shows');
  check(await waitFor(() => records().includes('m:msg_verify_android_arrived'), 10_000), 'and the app keeps the copy', records());

  // 3. The app opens on that chat, as the notification opens it, the hub still gone.
  sh(`am start -W -n ${PKG}/org.libdither.chat.MainActivity --es hash /inbox/c/${conv.id} >/dev/null`);
  await attach();
  check(await until(shown(BODY), 60_000), 'offline: the chat shows the message from the push', await page(`({ app: !!document.querySelector('.app'), msgs: document.querySelectorAll('.timeline-scroll .msg').length, hash: location.hash })`).catch(() => null));
  check(await page<boolean>(`!!document.querySelector('.arrived-sep')`), 'with the line that says earlier messages may be missing');
  if (shots) {
    sh('screencap -p /data/local/tmp/dither-arrived.png');
    adb('pull', '/data/local/tmp/dither-arrived.png', join(shots, 'android-arrived-chat.png'));
  }
  await page(`history.back()`);
  await until(`!!document.querySelector('[data-row]')`, 10_000);
  const row = await page<string | null>(`document.querySelector('[data-row=${JSON.stringify(conv.id)}]')?.textContent ?? null`);
  check(!!row?.includes(BODY), "and the chat's row in the list shows it", row?.slice(0, 120));
  await page(`location.hash = '#/inbox/c/${conv.id}'`);
  await until(shown(BODY), 10_000);

  // 4. Another push while the app is open and offline: the page has it at once, without a restart.
  push(payload('msg_verify_android_live', LIVE, 2));
  check(await until(shown(LIVE), 15_000), 'a push while the app is open: the open chat shows it');
  check(await waitFor(() => records().length === 2, 10_000), 'and the app keeps both', records());

  // 5. The hub back: its answer replaces the copies, and the records go.
  await startHub();
  check(await until(`performance.getEntriesByName('dither:fresh').length > 0`, 60_000), 'the hub back: the app catches up');
  check(
    await until(`!document.querySelector('.arrived-sep') && !(${shown(BODY)}) && !(${shown(LIVE)})`, 20_000),
    "its answer replaces both copies (it never had these messages), and the line goes",
  );
  check(await waitFor(() => records().length === 0, 15_000), "the app's records are deleted", records());

  // 6. Nothing died.
  const dead = deaths();
  check(dead.length === 0, 'no crash or ANR of the app in logcat', dead.slice(0, 3));
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  try {
    sh(`am force-stop ${PKG}`);
    sh(`pm clear ${PKG} >/dev/null`);
    adb('reverse', '--remove', `tcp:${port}`);
    if (phone.cdpPort) adb('forward', '--remove', `tcp:${phone.cdpPort}`);
  } catch {}
  await stopHub();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
