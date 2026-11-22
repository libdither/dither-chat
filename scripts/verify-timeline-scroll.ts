/**
 * The timeline's scroll, against a demo hub of its own (docs/chats.md, "Following the newest"):
 *   bun run web:build && bun scripts/verify-timeline-scroll.ts [<hub url>] [--shots <dir>]
 *
 * - A message that comes in while the view is a pixel or a few above the newest end is shown, not left below the view
 *   (the browser's scroll anchoring would hold the old view still).
 * - Further up, what is being read stays where it is.
 * - The pointer on a reply's quote line lights up the message it points to; a click brings that one to the middle and
 *   lights it up for a moment, a drawn one too.
 * Sends only on the demo adapter, through its hub.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch } from './browser.ts';

const args = process.argv.slice(2);
const si = args.indexOf('--shots');
const shots = si >= 0 ? args.splice(si, 2)[1] : null;
if (shots) mkdirSync(shots, { recursive: true });

async function ownHub() {
  const data = mkdtempSync(join(tmpdir(), 'dither-scroll-hub-'));
  const s = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  const web = process.env.DITHER_WEB_DIST ? ['--web', process.env.DITHER_WEB_DIST] : [];
  const proc = Bun.spawn(['bun', 'packages/hub/src/main.ts', '--demo', '--data', data, '--port', String(port), '--host', '127.0.0.1', ...web], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, DITHER_CALENDAR_URL: 'off', DITHER_DEMO_CHATTER: '0' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  const url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  while (!(await fetch(`${url}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error('the demo hub did not answer');
    await Bun.sleep(200);
  }
  return { url, stop: async () => (proc.kill(), await proc.exited, rmSync(data, { recursive: true, force: true })) };
}
const own = args[0] ? null : await ownHub();
const hub = args[0] ?? own!.url;
const api = (p: string, init?: RequestInit) => fetch(hub + p, init).then((r) => r.json() as Promise<any>);
const boot = await api('/api/bootstrap');
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub: refusing');

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

// The chat with the most messages, so it scrolls.
const sizes = await Promise.all(
  boot.conversations
    .filter((c: any) => c.shape === 'channel' && c.network === 'discord')
    .map(async (c: any) => ({ c, msgs: (await api(`/api/conversations/${c.id}/messages?limit=200`)).messages as any[] })),
);
const { c: chat } = sizes.sort((a, b) => b.msgs.length - a.msgs.length)[0];
const send = (body: string, replyTo?: string) =>
  fetch(`${hub}/api/conversations/${chat.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, replyTo }) }).then((r) => r.ok);

const b = await launch();
const p = b.page;
try {
  await p.size(1000, 560);
  await p.send('Emulation.setTimezoneOverride', { timezoneId: 'Etc/UTC' });
  await p.goto(`${hub}/#/c/${encodeURIComponent(chat.id)}`);
  await p.until(`document.querySelectorAll('.timeline-scroll .msg').length > 5`, 15000);
  const scrolls = await p.eval<boolean>(`(() => { const s = document.querySelector('.timeline-scroll'); return s.scrollHeight > s.clientHeight + 200 })()`);
  check(scrolls, 'the chat is long enough to scroll', chat.id);

  /** Scrolls to `top` (0 is the newest end), sends a message, waits for it, and says where it is drawn. */
  const arrive = async (top: number, body: string, replyTo?: string) => {
    await p.eval(`(async () => { const s = document.querySelector('.timeline-scroll'); s.scrollTop = ${top}; s.dispatchEvent(new Event('scroll')); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
    const before = await p.eval<number>(`document.querySelector('.timeline-scroll').scrollTop`);
    // A message in the middle of the view: where it is drawn says whether what is being read moved.
    const seen = await p.eval<{ id: string; y: number }>(`(() => { const s = document.querySelector('.timeline-scroll').getBoundingClientRect(); const m = [...document.querySelectorAll('.timeline-scroll .msg[id]')].find((x) => { const r = x.getBoundingClientRect(); return r.top > s.top && r.bottom < s.bottom; }); return { id: m.id, y: m.getBoundingClientRect().top }; })()`);
    if (!(await send(body, replyTo))) throw new Error('the demo hub refused the send');
    await p.until(`[...document.querySelectorAll('.timeline-scroll .msg')].some((m) => m.textContent.includes(${JSON.stringify(body)}))`, 8000);
    // Two frames: what the browser and the timeline do about it is done.
    return p.eval<{ before: number; after: number; below: number; moved: number }>(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const s = document.querySelector('.timeline-scroll');
      const m = [...s.querySelectorAll('.msg')].find((x) => x.textContent.includes(${JSON.stringify(body)}));
      r({ before: ${before}, after: s.scrollTop, below: Math.round(m.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom), moved: Math.round(document.getElementById(${JSON.stringify(seen.id)}).getBoundingClientRect().top - ${seen.y}) });
    })))`);
  };

  for (const off of [0, -1, -6, -20]) {
    const r = await arrive(off, `following ${off} ${Date.now()}`);
    check(r.below <= 1 && r.after === 0, `${-off}px above the newest end, a new message is shown`, r);
  }
  // Code that measures right after a message is added forces a layout before the ResizeObserver's turn: the browser's
  // anchoring then moves the view, and its scroll event comes first. The view follows all the same.
  await p.eval(`(window.__forcer = new MutationObserver(() => document.querySelector('.timeline-scroll').scrollHeight)).observe(document.querySelector('.timeline-inner'), { childList: true, subtree: true })`);
  for (const off of [-1, -20]) {
    const r = await arrive(off, `forced ${off} ${Date.now()}`);
    check(r.below <= 1 && r.after === 0, `with a layout forced as it comes in, ${-off}px above the newest end, a new message is shown`, r);
  }
  await p.eval(`window.__forcer.disconnect()`);
  const far = await arrive(-400, `far ${Date.now()}`);
  check(far.moved === 0 && far.below > 300, 'far up, what is being read stays where it is', far);

  // A reply to a message far up: its quote line points there.
  // Forty rows up: more than a screen and a half, with messages above it to be centred among.
  const quotedMsg = { id: await p.eval<string>(`(() => { const ms = [...document.querySelectorAll('.timeline-scroll .msg[id^="m-"]')]; return ms[ms.length - 40].id.slice(2); })()`) };
  const replyBody = `a reply far up ${Date.now()}`;
  await arrive(0, replyBody, quotedMsg.id);
  const q = `[...document.querySelectorAll('.timeline-scroll .msg')].find((m) => m.textContent.includes(${JSON.stringify(replyBody)})).querySelector('.reply-quote')`;
  check(await p.eval(`!!${q}`), 'the reply has a quote line');
  const target = `document.getElementById(${JSON.stringify(`m-${quotedMsg.id}`)})`;
  const drawnTarget = await p.eval<boolean>(`!!${target}`);
  if (drawnTarget) {
    await p.eval(`${q}.dispatchEvent(new MouseEvent('mouseenter'))`);
    check(await p.eval(`${target}.classList.contains('quoted-hover')`), 'the pointer on the quote line lights up the message it points to');
    await p.eval(`${q}.dispatchEvent(new MouseEvent('mouseleave'))`);
    check(!(await p.eval(`${target}.classList.contains('quoted-hover')`)), 'and off it, no longer');
  }
  const t0 = Date.now();
  await p.eval(`${q}.click()`);
  await p.until(`${target}?.classList.contains('flash')`, 6000).catch(() => {});
  const lit = await p.eval<{ flash: boolean; mid: number } | null>(`(() => { const t = ${target}; if (!t) return null; const s = document.querySelector('.timeline-scroll').getBoundingClientRect(); const r = t.getBoundingClientRect(); return { flash: t.classList.contains('flash'), mid: Math.round(r.top + r.height / 2 - (s.top + s.height / 2)) }; })()`);
  check(lit?.flash && Math.abs(lit.mid) < 40, 'a click on the quote line brings the message to the middle and lights it up', { ...lit, ms: Date.now() - t0 });
  if (shots) await p.shot(join(shots, 'quote-jump.png'));

  // Clicked again with the message already in view: lit up again (it was not, before).
  await p.until(`!${target}.classList.contains('flash')`, 4000);
  // A reply to the message two rows up: both on screen.
  const nearId = await p.eval<string>(`(() => { const ms = [...document.querySelectorAll('.timeline-scroll .msg[id^="m-"]')]; return ms[ms.length - 2].id.slice(2); })()`);
  const nearText = `near ${Date.now()}`;
  await arrive(0, nearText, nearId);
  const nearQuote = `[...document.querySelectorAll('.timeline-scroll .msg')].find((m) => m.textContent.includes(${JSON.stringify(nearText)})).querySelector('.reply-quote')`;
  const nearTarget = `document.getElementById(${JSON.stringify(`m-${nearId}`)})`;
  check(await p.eval(`!!${nearQuote}`), 'a reply to a message near the end has a quote line');
  if (shots) {
    // The reply and the message its quote line points to, both in sight, the pointer on the line.
    await p.eval(`${nearQuote}.dispatchEvent(new MouseEvent('mouseenter'))`);
    await p.shot(join(shots, 'quote-hover.png'));
    await p.eval(`${nearQuote}.dispatchEvent(new MouseEvent('mouseleave'))`);
  }
  await p.eval(`${nearQuote}.click()`);
  const again = await p.until(`${nearTarget}?.classList.contains('flash')`, 3000).then(() => true, () => false);
  check(again, 'a quoted message already drawn is lit up too');
  // A phone draws messages off screen lazily (content-visibility), which changes sizes as they come into view.
  await p.size(390, 760, true);
  await p.goto(`${hub}/#/c/${encodeURIComponent(chat.id)}`);
  await p.until(`document.querySelectorAll('.timeline-scroll .msg').length > 5`, 15000);
  for (const off of [-1, -20]) {
    const r = await arrive(off, `phone ${off} ${Date.now()}`);
    check(r.below <= 1 && r.after === 0, `on a phone, ${-off}px above the newest end, a new message is shown`, r);
  }
  if (shots) await p.shot(join(shots, 'phone-newest.png'));
  if (p.errors.length) check(false, 'no page errors', p.errors);
} finally {
  await b.close();
  await own?.stop();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
