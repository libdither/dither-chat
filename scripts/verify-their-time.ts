/**
 * Their time (docs/profile.md "Their time"), end to end against a demo hub of its own with friends abroad
 * (DITHER_DEMO_SCENARIO=zulip,clocks) in headless Chromium set to Chicago's time: a guessed clock shows with "~" beside
 * your time, a profile's zone without it (asked for in the background on Zulip), someone in your own zone shows none;
 * pointing at a time shows their usual day, in their time or yours, with Week; Escape closes it; a click keeps it open
 * and back closes it; a zone set by hand replaces the guess.
 *
 *   bun run web:build && bun scripts/verify-their-time.ts [shots dir]
 * Starts its own hub on a free port with a throwaway data dir. DITHER_WEB_DIST serves another web build.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const REPO = resolve(import.meta.dir, '..');
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'dither-their-time-hub-'));
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

const hub = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
  cwd: REPO,
  env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0', DITHER_DEMO_SCENARIO: 'zulip,clocks' },
  stdout: 'ignore',
  stderr: 'inherit',
});
const { page: p, close } = await launch();

/** The their-time labels on the open chat's messages, by author name. */
const labels = () =>
  p.eval<{ who: string; time: string; theirs: string | null }[]>(`[...document.querySelectorAll('.msg-head')].map((h) => ({
    who: h.querySelector('.msg-author')?.textContent ?? '',
    time: h.querySelector('.msg-time')?.textContent ?? '',
    theirs: h.querySelector('.msg-their-time')?.textContent ?? null,
  }))`);
/** Point at an element (by selector) the way a mouse does, so the page sees pointerenter. */
async function point(sel: string) {
  const r = await p.eval<{ x: number; y: number } | null>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  if (!r) throw new Error(`nothing at ${sel}`);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  return r;
}
async function click(x: number, y: number) {
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const key = async (k: 'Escape') => {
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: 27 });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: 27 });
};
const card = () => p.eval<string | null>(`document.querySelector('.their-day.shown')?.innerText ?? null`);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));

try {
  const end = Date.now() + 60_000;
  while (!(await fetch(`${url}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the hub did not start');
    await Bun.sleep(200);
  }
  let boot: any;
  const find = async (name: string) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      boot = await (await fetch(`${url}/api/bootstrap`)).json();
      const c = boot.conversations.find((x: any) => x.name === name);
      if (c) return c.id as string;
      if (Date.now() > deadline) throw new Error(`no conversation named ${name}`);
      await Bun.sleep(300);
    }
  };
  const group = await find('Across time zones');
  if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' });
  await p.size(1280, 860);

  // A group of friends abroad: Mika (Tokyo) and Lena (Berlin) guessed, Sam in your own zone shown nothing.
  await p.goto(`${url}/#/inbox/c/${group}`);
  await p.until(`document.querySelectorAll('.msg-their-time').length > 3`, 30_000);
  const seen = await labels();
  const of = (who: string) => seen.filter((l) => l.who.startsWith(who));
  check(of('Mika').length && of('Mika').every((l) => l.theirs?.startsWith('~') || l.theirs?.includes('~')), "Mika's messages show a guessed time beside yours", of('Mika').slice(-2));
  check(of('Lena').length && of('Lena').every((l) => l.theirs?.includes('~')), "Lena's show a guessed time too", of('Lena').slice(-2));
  check(of('Sam').length && of('Sam').every((l) => l.theirs === null), 'Sam, in your zone, shows none', of('Sam').slice(-2));
  await shot('chat');

  // Pointing at Mika's time shows her day in her time; Your time and Week; Escape closes it.
  const mika = `.msg-head:has(.msg-author[data-identity]) .msg-their-time`;
  const lastMika = await p.eval<string>(`(() => { const hs = [...document.querySelectorAll('.msg-head')].filter((h) => h.querySelector('.msg-author')?.textContent?.startsWith('Mika') && h.querySelector('.msg-their-time')); const h = hs.at(-1); h.setAttribute('data-probe', 'mika'); return 'ok'; })()`);
  void lastMika;
  void mika;
  await point(`[data-probe="mika"] .msg-their-time`);
  await p.until(`!!document.querySelector('.their-day.shown .td-bar')`, 15_000);
  const text = (await card()) ?? '';
  check(/for Mika/.test(text) && /Guessed from when they are around/.test(text) && /reactions/.test(text), 'the card shows her time and says it is a guess', text.split('\n').slice(0, 3));
  check(/Usually quiet/.test(text), 'and when she is usually quiet', text.match(/Usually quiet[^\n]*/)?.[0]);
  await shot('card');
  await p.eval(`document.querySelector('.their-day .td-frames button:last-child').click()`);
  await p.until(`/for you/.test(document.querySelector('.their-day')?.innerText ?? '')`, 5_000);
  check(true, 'Your time shows the same day in your time');
  await p.eval(`[...document.querySelectorAll('.their-day .link-btn')].find((b) => b.textContent === 'Week').click()`);
  await p.until(`!!document.querySelector('.their-day .td-week')`, 5_000);
  check(true, 'Week shows the week by weekday');
  await shot('card-week');
  await key('Escape');
  await p.until(`!document.querySelector('.their-day')`, 5_000);
  check(true, 'Escape closes a card shown by pointing');

  // A click keeps it open; back closes it.
  const at = await point(`[data-probe="mika"] .msg-their-time`);
  await click(at.x, at.y);
  await p.until(`!!document.querySelector('.their-day.shown .td-bar')`, 15_000);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await Bun.sleep(400);
  check(!!(await card()), 'a card opened by a click stays when the pointer leaves');
  await p.eval('history.back()');
  await p.until(`!document.querySelector('.their-day')`, 5_000);
  check((await p.eval<string>('location.hash')).includes(group), 'back closes it and stays in the chat', await p.eval('location.hash'));

  // A zone set by hand replaces the guess.
  await click(...(Object.values(await point(`[data-probe="mika"] .msg-their-time`)) as [number, number]));
  await p.until(`!!document.querySelector('.their-day.shown .td-bar')`, 15_000);
  await p.eval(`[...document.querySelectorAll('.their-day .link-btn')].find((b) => b.textContent === 'Set time zone').click()`);
  await p.until(`!!document.querySelector('.their-day .td-zone select')`, 5_000);
  await p.eval(`(() => { const s = document.querySelector('.their-day .td-zone select'); s.value = 'Asia/Seoul'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.until(`/set by you/.test(document.querySelector('.their-day')?.innerText ?? '')`, 10_000);
  await p.until(`!document.querySelector('[data-probe="mika"] .msg-their-time')?.textContent?.includes('~')`, 10_000);
  check(true, "a zone set by hand shows as hers, without the '~'");
  await key('Escape');

  // Zulip states zones: asked for in the background, then shown exactly.
  const topic = await find('Color tokens');
  await p.goto(`${url}/#/inbox/c/${topic}`);
  await p.until(`[...document.querySelectorAll('.msg-head')].some((h) => h.querySelector('.msg-author')?.textContent?.startsWith('Ada') && h.querySelector('.msg-their-time') && !h.querySelector('.msg-their-time').textContent.includes('~'))`, 30_000);
  check(true, "Ada's zone comes from her Zulip profile, asked for in the background, and shows without '~'");
  await shot('zulip');

  // A phone: the time is a button to tap.
  await p.size(390, 800, true);
  await p.goto(`${url}/#/inbox/c/${group}`);
  await p.until(`document.querySelectorAll('.msg-their-time').length > 3`, 30_000);
  await p.eval(`document.querySelectorAll('.msg-their-time')[document.querySelectorAll('.msg-their-time').length - 1].click()`);
  await p.until(`!!document.querySelector('.their-day.shown .td-bar')`, 15_000);
  await shot('phone');
  await p.eval('history.back()');
  await p.until(`!document.querySelector('.their-day')`, 5_000);
  check(true, 'on a phone a tap opens it and back closes it');
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} catch (e) {
  failed++;
  console.log(`FAIL ${(e as Error).message}`);
} finally {
  await close();
  hub.kill();
  await hub.exited;
  rmSync(data, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
