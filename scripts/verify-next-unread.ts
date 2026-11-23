/**
 * Next unread topic and a channel's Mark As Read (docs/threads.md "Next unread, and reading a channel at once") in a
 * real browser against a fresh demo hub, with real key and mouse input, on the demo's Zulip organization:
 *
 *   - at the bottom of a topic, the bar names the next one: the topic that mentions you, before a later one;
 *   - `n` goes there, and leaves the caret out of the message box, so `n` goes on;
 *   - read that one, the bar and `n` go on to the next channel's unread topic, past the channel whose only unread
 *     topic is muted, and past the first topic, left unread (the page's read of it held back);
 *   - `n` typed in the message box is a letter;
 *   - the muted topic's channel's Mark As Read reads it, with no confirm;
 *   - a Discord text channel's Mark As Read reads its thread too.
 *
 *   bun packages/hub/src/main.ts --demo --data <fresh dir> --port <port> --web <built web>
 *   bun scripts/verify-next-unread.ts http://127.0.0.1:<port> [screenshot dir]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const base = process.argv[2];
const shots = process.argv[3];
if (!base) throw new Error('usage: bun scripts/verify-next-unread.ts <hub url> [screenshot dir]');
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

const boot = () => fetch(`${base}/api/bootstrap`).then((r) => r.json() as Promise<any>);
const first = await boot();
if (!first.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub: refusing');
const convs = (b: any): any[] => b.conversations;
const named = (b: any, network: string, name: string) => convs(b).find((c) => c.network === network && c.name === name);
const unread = async (id: string) => Math.max(0, ...convs(await boot()).find((c) => c.id === id).vantages.map((v: any) => v.unread));
/** Polls the hub for the exact thing: this conversation's unread count reaching `n`. */
const untilUnread = async (id: string, n: number, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await unread(id)) === n) return true;
    await Bun.sleep(100);
  }
  return false;
};

const zulip = first.spaces.find((s: any) => s.network === 'zulip' && s.kind === 'community');
const spacing = named(first, 'zulip', 'Spacing scale');
const tokens = named(first, 'zulip', 'Color tokens');
const lunch = named(first, 'zulip', 'Lunch plans');
const nightly = named(first, 'zulip', 'Nightly builds');
const releases = named(first, 'zulip', 'releases');
if (!zulip || !spacing || !tokens || !lunch || !nightly || !releases) throw new Error('the demo has no Zulip organization as expected');

const { page, close } = await launch();
const press = async (key: string) => {
  const vk = key.toUpperCase().charCodeAt(0);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: vk, text: key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: vk });
};
const mouse = async (type: string, x: number, y: number, button: 'left' | 'right' | 'none') =>
  page.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'right' ? 2 : button === 'left' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
const clickAt = async (at: { x: number; y: number }, button: 'left' | 'right' = 'left') => {
  await mouse('mouseMoved', at.x, at.y, 'none');
  await mouse('mousePressed', at.x, at.y, button);
  await mouse('mouseReleased', at.x, at.y, button);
};
const center = (expr: string) => page.eval<{ x: number; y: number } | null>(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const bar = () => page.eval<string>(`document.querySelector('.next-unread')?.textContent ?? ''`);
const hash = () => page.eval<string>('decodeURIComponent(location.hash)');
const inBox = () => page.eval<boolean>(`document.activeElement?.tagName === 'TEXTAREA'`);
/** Counts confirm() calls instead of answering them: Mark As Read on a channel must not ask. */
const confirms = () => page.eval<number>('window.__confirms ?? 0');

try {
  await page.size(1400, 900);
  // The page's read of the first topic is held back, as one left in a moment is never read: it stays unread, and only
  // the rule that passes over what you went on from keeps `n` from going back to it.
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes(${JSON.stringify(`/api/conversations/${spacing.id}/read`)}) ? Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })) : f(u, o); })()`,
  });
  await page.goto(`${base}/#/s/${encodeURIComponent(zulip.id)}/c/${encodeURIComponent(spacing.id)}`);
  await page.until(`!!document.querySelector('.next-unread')`, 20000).catch(() => {});
  await page.eval(`window.__confirms = 0; window.confirm = () => (window.__confirms++, true); document.activeElement?.blur()`);
  const one = await bar();
  check('at the bottom of a topic, the bar names the next: the one that mentions you', one.includes('Color tokens') && one.includes('@'), one);
  if (shots) await page.shot(`${shots}/bar-same-channel.png`);

  await press('n');
  await page.until(`decodeURIComponent(location.hash).includes(${JSON.stringify(tokens.id)})`, 5000).catch(() => {});
  check('n goes there', (await hash()).includes(tokens.id), await hash());
  // The composer of the topic gone to is drawn (its box names it) before the caret is looked for.
  await page.until(`document.querySelector('textarea')?.placeholder?.includes('Color tokens')`, 8000).catch(() => {});
  check('…and the caret stays out of the box', !(await inBox()));
  check('the topic n went to is read once seen', await untilUnread(tokens.id, 0));

  check('the topic left stays unread', (await unread(spacing.id)) > 0, await unread(spacing.id));

  // design has nothing more but the topic left; releases' only unread topic is muted: next is general's.
  await page.until(`(document.querySelector('.next-unread')?.textContent ?? '').includes('Lunch plans')`, 8000).catch(() => {});
  const two = await bar();
  check("then the next channel's unread topic, past a muted one and the one left", two.includes('Lunch plans') && two.includes('general') && !two.includes('Nightly') && !two.includes('Spacing'), two);
  if (shots) await page.shot(`${shots}/bar-next-channel.png`);
  await clickAt((await center(`document.querySelector('.next-unread')`))!);
  await page.until(`decodeURIComponent(location.hash).includes(${JSON.stringify(lunch.id)})`, 5000).catch(() => {});
  check('a click on the bar goes there', (await hash()).includes(lunch.id), await hash());
  // Nothing more in this organization (the muted topic aside): the bar names the next server.
  await page.until(`(document.querySelector('.next-unread-chan')?.textContent ?? '') !== ''`, 8000).catch(() => {});
  check('past the last unread topic here, the bar names the next server', (await page.eval<number>(`document.querySelectorAll('.next-unread-chan').length`)) > 0, await bar());
  if (shots) await page.shot(`${shots}/bar-next-server.png`);

  // n typed in the box is a letter.
  const box = await center(`document.querySelector('textarea')`);
  if (box) await clickAt(box);
  await press('n');
  const typed = await page.eval<string>(`document.querySelector('textarea')?.value ?? ''`);
  check('n typed in the message box is a letter', typed.endsWith('n') && (await hash()).includes(lunch.id), { typed, at: await hash() });
  await page.eval(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);

  // A channel's Mark As Read: the muted topic's channel, no confirm.
  check('the muted topic starts unread', (await unread(nightly.id)) > 0);
  const row = await center(`[...document.querySelectorAll('.chan:not(.thread)')].find((b) => b.querySelector('.chan-name')?.textContent === 'releases')`);
  if (!row) throw new Error('no releases row in the sidebar');
  await clickAt(row, 'right');
  await page.until(`!!document.querySelector('.cm')`, 3000);
  if (shots) await page.shot(`${shots}/channel-menu.png`);
  const item = await center(`[...document.querySelectorAll('.cm-item')].find((b) => b.textContent.trim().startsWith('Mark As Read'))`);
  if (!item) throw new Error('no Mark As Read');
  await clickAt(item);
  check("a channel's Mark As Read reads its topics", await untilUnread(nightly.id, 0));
  check('…without a confirm', (await confirms()) === 0, await confirms());

  // A Discord text channel with a thread: Mark Unread on the thread's message, then the channel's Mark As Read.
  const b = await boot();
  const thread = convs(b).find((c) => c.network === 'discord' && c.shape === 'thread' && c.name === 'DHT bootstrap refactor');
  const channel = thread && convs(b).find((c) => c.id === thread.parentId);
  if (!thread || !channel) throw new Error('the demo has no Discord thread under a text channel');
  const msgs = await fetch(`${base}/api/conversations/${thread.id}/messages?limit=5`).then((r) => r.json() as Promise<any>);
  const last = (msgs.messages ?? msgs)[0];
  if (last) await fetch(`${base}/api/messages/${last.id}/unread`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  const before = await unread(thread.id);
  // The channel in its server: the space it is listed in, or the community above a category.
  const space = channel.spaceIds[0];
  const up = b.edges?.find?.((e: any) => e.childKind !== 'conversation' && e.childId === space)?.parentId;
  const top = b.spaces.find((s: any) => s.id === space)?.kind === 'community' ? space : (up ?? space);
  await page.goto(`${base}/#/s/${encodeURIComponent(top)}/c/${encodeURIComponent(channel.id)}`);
  await page.until(`!!document.querySelector('.chan.active')`, 10000).catch(() => {});
  // The page holds the thread as unread (its row says so) before the menu is opened.
  await page.until(`[...document.querySelectorAll('.chan.thread.unread .chan-name')].some((e) => e.textContent === ${JSON.stringify(thread.name)})`, 8000).catch(() => {});
  const chan = await center(`document.querySelector('.chan.active:not(.thread)')`);
  if (chan && before > 0) {
    await clickAt(chan, 'right');
    await page.until(`!!document.querySelector('.cm')`, 3000);
    const mark = await center(`[...document.querySelectorAll('.cm-item')].find((b) => b.textContent.trim().startsWith('Mark As Read'))`);
    if (mark) await clickAt(mark);
    check("a Discord text channel's Mark As Read reads its thread", await untilUnread(thread.id, 0), { before });
    check('…without a confirm', (await confirms()) === 0, await confirms());
  } else check('a Discord thread made unread to read again', false, { before, chan });
} finally {
  if (page.errors.length) console.log('page errors:', page.errors.slice(0, 5));
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
