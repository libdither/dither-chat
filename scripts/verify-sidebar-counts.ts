/**
 * A server's sidebar follows reads made elsewhere (docs/servers.md "Threads under a channel"): with the server open,
 * a topic of another channel read on another device loses its bold and its count, and so does its channel's line;
 * marked unread there, both come back. End to end against a demo hub of its own (the Zulip world) in headless
 * Chromium; the page reads nothing itself, the hub's API stands in for the other device.
 *
 *   bun scripts/verify-sidebar-counts.ts
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const data = mkdtempSync(join(tmpdir(), 'dither-sidebar-hub-'));
const port = await new Promise<number>((done) => {
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  done(p);
});
const url = `http://127.0.0.1:${port}`;
const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];

let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
};
/** Waits for `f` to give something, up to `ms`; null if it never did (the check after says what was wrong). */
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await Bun.sleep(100);
  }
}

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0', DITHER_DEMO_SCENARIO: 'zulip' },
  stdout: 'ignore',
  stderr: 'inherit',
});
const { page: p, close } = await launch();

type Conv = { id: string; name: string; network: string; shape: string; parentId: string | null; vantages: { unread: number; mentions: number }[] };
try {
  const boot = await until(async () => {
    const r = await fetch(`${url}/api/bootstrap`);
    return r.ok ? ((await r.json()) as { conversations: Conv[]; spaces: { id: string; network: string }[] }) : null;
  }, 180_000);
  if (!boot) throw new Error('the hub did not start');
  const zulip = boot.conversations.filter((c) => c.network === 'zulip');
  const space = boot.spaces.find((s) => s.network === 'zulip')!;
  const unread = (c: Conv) => c.vantages.some((v) => v.unread > 0);
  const topic = zulip.find((c) => c.shape === 'thread' && unread(c));
  if (!topic) throw new Error('the Zulip world has no unread topic');
  const channel = zulip.find((c) => c.id === topic.parentId)!;
  const other = zulip.find((c) => c.shape === 'channel' && c.id !== channel.id)!;

  /** The topic's sidebar row: whether it is bold, and its count. */
  const row = () =>
    p.eval<{ bold: boolean; count: string } | null>(
      `(() => { const e = [...document.querySelectorAll('.chan.thread')].find((x) => x.querySelector('.chan-name')?.textContent === ${JSON.stringify(topic.name)}); return e ? { bold: e.classList.contains('unread'), count: e.querySelector('.count')?.textContent ?? '' } : null; })()`,
    );
  /** The channel's own line: its count. */
  const head = () =>
    p.eval<string | null>(
      `(() => { const e = [...document.querySelectorAll('.chan:not(.thread)')].find((x) => x.querySelector('.chan-name')?.textContent === ${JSON.stringify(channel.name)}); return e ? e.querySelector('.count')?.textContent ?? '' : null; })()`,
    );

  await p.size(1360, 860);
  // Another channel of the server open: the page reads nothing of the topic itself.
  await p.goto(`${url}/#/s/${encodeURIComponent(space.id)}/c/${encodeURIComponent(other.id)}`);
  const before = await until(async () => {
    const r = await row();
    return r?.bold ? r : null;
  }, 20_000);
  check(before, 'the unread topic is bold in the sidebar', before);
  const headBefore = await head();

  // Read on another device.
  const read = await fetch(`${url}/api/conversations/${topic.id}/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(read.ok, 'the hub takes the read', read.status);
  const cleared = await until(async () => {
    const r = await row();
    return r && !r.bold && !r.count ? r : null;
  });
  check(cleared, 'read elsewhere: the topic is no longer bold and has no count', await row());
  const headAfter = await until(async () => {
    const h = await head();
    return h !== null && h !== headBefore ? { h } : null;
  });
  check(!headBefore || headAfter, "read elsewhere: the channel's count follows", { before: headBefore, now: await head() });

  // Marked unread on another device, from its newest message.
  const msgs = (await (await fetch(`${url}/api/conversations/${topic.id}/messages?limit=5`)).json()) as { messages: { id: string }[] };
  const last = msgs.messages.at(-1);
  const un = last ? await fetch(`${url}/api/messages/${last.id}/unread`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) : null;
  check(un?.ok, 'the hub takes Mark Unread', un?.status);
  const back = await until(async () => {
    const r = await row();
    return r?.bold ? r : null;
  });
  check(back, 'marked unread elsewhere: the topic is bold again', await row());
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
