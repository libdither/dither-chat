/**
 * The sign-in screen (docs/login.md) in headless Chromium, as a person uses it: a cold start without a session, the
 * form on top (nothing over it, such as index.html's start logo), typed into and clicked with real input events, and
 * the app in its place once signed in.
 *
 *   bun scripts/verify-login.ts
 * Starts its own hub behind the login, on a free port with a throwaway data dir (scripts/hub-login.ts).
 * DITHER_WEB_DIST serves another web build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';
import { prepareLogin, THROWAWAY_PASSWORD } from './hub-login.ts';

const REPO = resolve(import.meta.dir, '..');
const data = mkdtempSync(join(tmpdir(), 'dither-login-hub-'));
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

await prepareLogin(data);
const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off' },
  stdout: 'ignore',
  stderr: 'inherit',
});
for (let i = 0; i < 200; i++) {
  if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) break;
  await Bun.sleep(50);
}

const { page: p, close } = await launch();
/** The middle of the first visible match, and what the page would hit there. */
const at = (sel: string) =>
  p.eval<{ x: number; y: number; hit: string; own: boolean } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; const b = e.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; const h = document.elementFromPoint(x, y); return { x, y, hit: h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') : 'nothing', own: !!h && (h === e || e.contains(h)) }; })()`,
  );
const click = async (sel: string) => {
  const r = await at(sel);
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};

try {
  await p.size(412, 915);
  await p.goto(`${url}/`);
  await p.until(`!!document.querySelector('.login-screen input[type=password]')`, 15000);
  check(!(await p.eval<boolean>(`!!document.getElementById('boot-static')`)), 'the start logo is gone once the sign-in screen shows');
  for (const sel of ['#login-user', '#login-password', '.login-screen button[type=submit]']) {
    const r = await at(sel);
    check(r?.own, `${sel} is on top where it is drawn`, r?.hit);
  }

  await click('#login-password');
  check((await p.eval<string>(`document.activeElement?.id ?? ''`)) === 'login-password', 'a click puts the cursor in the password');
  await p.send('Input.insertText', { text: THROWAWAY_PASSWORD });
  await p.until(`!document.querySelector('.login-screen button[type=submit]').disabled`, 5000);
  await click('.login-screen button[type=submit]');
  await p.until(`!document.querySelector('.login-screen')`, 15000);
  check(true, 'signing in leaves the sign-in screen');
  check((await p.eval<number>(`fetch('/api/bootstrap').then((r) => r.status)`)) === 200, 'and the page has a session');
} catch (e) {
  check(false, 'ran to the end', String(e));
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
