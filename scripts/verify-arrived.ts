/**
 * A push's copy of its message shows before the hub answers (docs/notifications.md, "A copy in the push"), in headless
 * Chromium at a phone's size against a demo hub of its own:
 *   1. the app opens online, so a snapshot is kept, and is left;
 *   2. the hub stops, and a push about a new message in a group arrives at the worker, with its copy: the worker keeps it;
 *   3. the app opens on that chat with the hub still gone: its row in the list and the chat show the message, under the
 *      line that says earlier messages may be missing;
 *   4. the hub is back: its answer replaces the copy (this hub never had that message, so it goes), the line goes, and
 *      the worker's record is deleted.
 * Pushes go to the worker over DevTools (ServiceWorker.deliverPushMessage): headless Chromium cannot reach a relay.
 *
 *   bun run web:build && bun scripts/verify-arrived.ts [--shots <dir>]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-arrived-hub-'));
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
};
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out at ${at().trim()} waiting for ${what}`);
    await Bun.sleep(100);
  }
}

let hub: ReturnType<typeof Bun.spawn> | null = null;
async function startHub() {
  hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: REPO,
    env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  await until('the hub to answer', () => fetch(`${url}/api/health`).then((r) => r.ok), 60_000);
}
async function stopHub() {
  hub?.kill('SIGKILL');
  await hub?.exited;
  hub = null;
}

await startHub();
const { page: p, close } = await launch();
const BODY = 'Arrived while you were away';
try {
  await p.size(412, 915, true);
  await p.send('Browser.grantPermissions', { origin: url, permissions: ['notifications'] });
  const regs: { registrationId: string; scopeURL: string }[] = [];
  p.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await p.send('ServiceWorker.enable');

  // 1. Online: the snapshot is kept.
  const boot = (await (await fetch(`${url}/api/bootstrap`)).json()) as { conversations: P.ConversationView[] };
  const conv = boot.conversations.filter((c) => c.shape === 'group' && c.lastMessageAt).sort((a, b) => b.lastMessageAt! - a.lastMessageAt!)[0];
  if (!conv) throw new Error('the demo world has no group with messages');
  await p.goto(`${url}/#/inbox`);
  await p.until(`!!navigator.serviceWorker?.controller && !!document.querySelector('.app')`, 30_000);
  const kept = () =>
    p.eval<boolean>(`new Promise((res) => {
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
    })`);
  await until('the snapshot to be kept', kept);
  check(true, 'online: the snapshot is kept');
  const reg = regs.find((r) => r.scopeURL.startsWith(url));
  if (!reg) throw new Error('no service worker registration');

  // 2. The hub gone; a push about a new message, with its copy, reaches the worker.
  const page = (await (await fetch(`${url}/api/conversations/${conv.id}/messages?limit=1`)).json()) as { messages: P.MessageView[] };
  const like = page.messages[0];
  const ts = Math.max(Date.now(), (conv.lastMessageAt ?? 0) + 1);
  const message: P.MessageView = { ...like, id: 'msg_verify_arrived', nativeId: 'verify-arrived', ts, editedTs: null, body: BODY, replyToId: null, attachments: [], embeds: [], reactions: [], deleted: false };
  const arrived: P.PushArrived = {
    message,
    lastMessage: { id: message.id, authorId: message.authorId, ts, kind: message.kind, text: BODY },
    lastMessageAt: ts,
    vantages: conv.vantages.map((v) => ({ ...v, unread: v.unread + 1 })),
  };
  await p.goto('about:blank');
  await stopHub();
  await p.send('ServiceWorker.startWorker', { scopeURL: reg.scopeURL });
  await p.send('ServiceWorker.deliverPushMessage', { origin: url, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Someone', body: BODY, conversationId: conv.id, arrived }) });
  const records = () =>
    p.evalWorker<number>(
      '/sw.js',
      `new Promise((res) => {
        const q = indexedDB.open('dither-arrived', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('arrived');
        q.onerror = () => res(-1);
        q.onsuccess = () => {
          const d = q.result;
          const a = d.transaction('arrived', 'readonly').objectStore('arrived').count();
          a.onsuccess = () => (d.close(), res(a.result));
        };
      })`,
    );
  await until('the worker to keep the copy', async () => (await records()) === 1);
  check(true, 'the hub gone, a push with its copy: the worker keeps it');

  // 3. The app opens on that chat, the hub still gone.
  await p.goto(`${url}/#/inbox/c/${conv.id}`);
  const shown = `document.querySelectorAll('.timeline-scroll .msg').length > 0 && [...document.querySelectorAll('.timeline-scroll .msg')].some((e) => e.textContent.includes(${JSON.stringify(BODY)}))`;
  try {
    await p.until(shown, 20_000);
    check(true, 'offline: the chat shows the message from the push');
  } catch {
    check(false, 'offline: the chat shows the message from the push', await p.eval(`({ app: !!document.querySelector('.app'), msgs: document.querySelectorAll('.timeline-scroll .msg').length })`).catch(() => null));
  }
  check(await p.eval<boolean>(`!!document.querySelector('.arrived-sep')`), 'with the line that says earlier messages may be missing');
  if (shots) await p.shot(join(shots, 'arrived-chat.png'));
  await p.eval(`history.back()`);
  await p.until(`!!document.querySelector('[data-row]')`, 10_000).catch(() => {});
  const row = await p.eval<string | null>(`document.querySelector('[data-row=${JSON.stringify(conv.id)}]')?.textContent ?? null`);
  check(!!row?.includes(BODY), "and the chat's row in the list shows it", row?.slice(0, 120));
  await p.eval(`location.hash = '#/inbox/c/${conv.id}'`);
  await p.until(shown, 10_000).catch(() => {});

  // 4. The hub back: its answer replaces the copy.
  await startHub();
  await p.until(`performance.getEntriesByName('dither:fresh').length > 0`, 45_000);
  await p.until(`!document.querySelector('.arrived-sep') && !(${shown})`, 20_000).catch(() => {});
  check(await p.eval<boolean>(`!document.querySelector('.arrived-sep') && !(${shown})`), "the hub back: its answer replaces the copy (it never had this message), and the line goes");
  await until("the worker's record to be deleted", async () => (await records()) === 0).then(
    () => check(true, "the worker's record is deleted"),
    () => check(false, "the worker's record is deleted"),
  );
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  await close();
  await stopHub();
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

