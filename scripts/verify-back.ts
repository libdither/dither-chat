/**
 * Back, everywhere (docs/desktop.md "Escape and back"), against a demo hub in headless Chromium: every kind of page
 * goes back where it came from by Escape and by the browser's back; every kind of layer (a sheet, menu, dialog,
 * picker or viewer) closes by Escape and by back without moving the page under it, and leaves no history entry
 * behind, so the next back goes on to the page before; the lists Escape has nowhere to go from stay put; and Escape in
 * a half-written message leaves the page alone. Then on a phone: back from each kind of page leaves it.
 *
 * The tables below name what each case covers: `view:` a route view (routes.ts), `file:` a component that opens a
 * layer (phone.ts pushLayer / useLayer). scripts/check-escape.ts fails when a view or such a file is in neither these
 * tables nor UNCOVERED, so a new page or a new overlay comes with its way back checked.
 *
 *   bun run web:build && bun scripts/verify-back.ts                    # starts a demo hub of its own (as CI does)
 *   bun scripts/verify-back.ts http://127.0.0.1:8881 [/tmp/shots]       # or uses one: a demo hub with its own data dir
 * Only reads, except a draft typed and cleared.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, type Page } from './browser.ts';

const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
/** A demo hub of its own, on a free port with a throwaway data dir, when none is given. */
const own = process.argv[2] ? null : await ownHub();
const hub = process.argv[2] ?? own!.url;
async function ownHub() {
  const data = mkdtempSync(join(tmpdir(), 'dither-back-hub-'));
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
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

const e = encodeURIComponent;
const dm = boot.conversations.find((c: any) => c.shape === 'direct' && c.network === 'discord');
const channel = boot.conversations.find((c: any) => c.shape === 'channel' && c.spaceIds?.length);
const space = channel?.spaceIds[0];
const person = boot.persons.find((p: any) => p.id !== boot.selfPersonId && p.identityIds?.length);
const account = boot.accounts[0];
const folder = boot.folders.find((f: any) => f.items.some((i: any) => i.kind === 'conversation'));
const folderConv = folder?.items.find((i: any) => i.kind === 'conversation').id;
if (!dm || !channel || !person || !folderConv) throw new Error('the demo world is missing a DM, a channel, a person or a folder with a chat');

let failures = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const b = await launch();
const p: Page = b.page;
const CODES: Record<string, number> = { Escape: 27, k: 75 };
async function key(k: string, modifiers = 0) {
  const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
  const ev = { key: k, code, modifiers, windowsVirtualKeyCode: CODES[k] ?? 0 };
  await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ev });
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
}
const hash = () => p.eval<string>('decodeURIComponent(location.hash)');
const norm = (h: string) => decodeURIComponent(h);
const layerOpen = () => p.eval<boolean>('history.state?.layer !== undefined');
/** What is drawn over the page: dialogs, menus, sheets, pickers, the viewer, and the popovers that are no layer. */
const OVER = '[role="dialog"], [role="menu"], [aria-modal="true"], .sheet-layer, .modal-backdrop, .viewer, .emoji-picker, .switcher, .theme-pop, .search-chip-pop, .cm';
const SHOWN = `[...document.querySelectorAll(${JSON.stringify(OVER)})].filter((el) => el.getClientRects().length).length`;
const overlays = () => p.eval<number>(SHOWN);
/** Waits for `expr` to hold in the page; says whether it did. */
const wait = (expr: string, ms = 5000) => p.until(expr, ms).then(() => true, () => false);
const hashIs = (h: string) => wait(`decodeURIComponent(location.hash) === ${JSON.stringify(norm(h))}`);
/** For what must not happen: Escape acts a task after the key, and its navigation within a frame or two of that. */
const quiet = () => Bun.sleep(300);
/** Goes to `h` as a typed address does: a new entry, which the app adopts with the one before it (state.ts). */
async function nav(h: string) {
  await p.eval(`location.hash = ${JSON.stringify(h)}`);
  await hashIs(h);
}
const blur = () => p.eval('document.activeElement?.blur?.()');
/** The middle of the first of `sel` on screen, or with `last` the last: the newest message, which nothing loads under. */
async function at(sel: string, last = false) {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getClientRects().length); const el = all[${last ? 'all.length - 1' : '0'}]; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 12) }; })()`,
  );
  if (!r) throw new Error(`nothing there: ${sel}`);
  return r;
}
async function hover(sel: string) {
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await at(sel, true)) });
}
async function click(sel: string, button: 'left' | 'right' = 'left', last = false) {
  const { x, y } = await at(sel, last);
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
}

/** A page and the list (or page) it is opened from; back from it lands on `from`. */
interface PageCase {
  name: string;
  view: string;
  from: string;
  to: string;
  /** Where the cursor is when Escape is pressed: nowhere (the default), or the page's own box. */
  focus?: string;
}
const PAGES: PageCase[] = [
  { name: 'a conversation from the inbox', view: 'inbox', from: '#/inbox', to: `#/inbox/c/${dm.id}` },
  { name: 'a channel from its server', view: 'space', from: `#/s/${space}`, to: `#/s/${space}/c/${channel.id}` },
  { name: 'a chat from its folder', view: 'folder', from: `#/f/${folder.id}`, to: `#/f/${folder.id}/c/${folderConv}` },
  { name: 'a person from People', view: 'people', from: '#/people', to: `#/people/${person.id}` },
  { name: "a person's profile from their conversation", view: 'profile', from: `#/inbox/c/${dm.id}`, to: `#/p/${person.id}` },
  { name: "a channel's About from the channel", view: 'profile', from: `#/s/${space}/c/${channel.id}`, to: `#/about/c/${channel.id}` },
  { name: 'the people graph', view: 'people', from: '#/people', to: '#/people/graph' },
  { name: 'Same person?', view: 'people', from: '#/people', to: '#/people/same' },
  { name: 'an account from Accounts', view: 'accounts', from: '#/accounts', to: `#/accounts/${account.id}` },
  { name: 'the directory', view: 'directory', from: '#/inbox', to: '#/directory' },
  { name: 'requests', view: 'requests', from: '#/inbox', to: '#/requests' },
  { name: 'notices', view: 'notices', from: '#/inbox', to: '#/notices' },
  { name: 'how it sorts', view: 'model', from: '#/foryou', to: '#/model' },
  { name: 'search, with the cursor in its box', view: 'search', from: '#/inbox', to: '#/search?q=pizza', focus: '.search-pane .search-main input' },
  { name: 'searching one conversation', view: 'search', from: `#/inbox/c/${dm.id}`, to: `#/search?q=${e(`hi in:${dm.id}`)}` },
  { name: 'Settings', view: 'settings', from: '#/inbox', to: '#/settings' },
];

/** Lists and tab roots: Escape has nowhere to go from these, and leaves them be. */
const ROOTS: { view: string; at: string }[] = [
  { view: 'inbox', at: '#/inbox' },
  { view: 'foryou', at: '#/foryou' },
  { view: 'people', at: '#/people' },
  { view: 'spaces', at: '#/spaces' },
  { view: 'space', at: `#/s/${space}` },
  { view: 'folder', at: `#/f/${folder.id}` },
  { view: 'accounts', at: '#/accounts' },
  { view: 'calendar', at: '#/calendar' },
  { view: 'feed', at: '#/feed' },
  { view: 'mail', at: '#/mail' },
];

/** A layer, opened on page `at`: it closes by Escape and by back, the page staying. */
interface LayerCase {
  name: string;
  file: string;
  at: string;
  open: () => Promise<unknown>;
  /** A popover that is no layer: Escape closes it, and back is the page's. */
  noLayer?: boolean;
}
const onMessage = (button: string) => async () => {
  await hover('.msg .msg-body');
  await p.until(`!!document.querySelector('.msg-actions')`);
  await click(`.msg-actions ${button}`);
};
const LAYERS: LayerCase[] = [
  { name: 'Ctrl+K', file: 'ui/Palette.tsx', at: `#/inbox/c/${dm.id}`, open: () => key('k', 2) },
  { name: "a message's menu", file: 'ui/ContextMenu.tsx', at: `#/inbox/c/${dm.id}`, open: () => click('.msg .msg-body', 'right', true) },
  { name: 'the reaction picker', file: 'ui/Reactions.tsx', at: `#/inbox/c/${dm.id}`, open: onMessage('[data-track="react"], .msg-actions [title="Add reaction"], .msg-actions [aria-label="Add reaction"]') },
  { name: 'Forward to (a dialog)', file: 'ui/bits.tsx', at: `#/inbox/c/${dm.id}`, open: onMessage('[data-track="forward"]') },
  { name: "search's filter chips", file: 'ui/Search.tsx', at: '#/search?q=pizza', open: () => click('.search-chip-main'), noLayer: true },
  { name: 'the theme picker', file: 'ui/Themes.tsx', at: '#/people', open: () => click('button[aria-label="Theme"]'), noLayer: true },
];

/**
 * Layers this run does not open, and why. Each closes on back and Escape through pushLayer as the rest do; they need a
 * file, an account kind, a network or a phone this run has none of.
 */
const UNCOVERED: Record<string, string> = {
  'ui/App.tsx': "a phone's details panel: the phone part's back covers its card",
  'ui/AccountPane.tsx': "the live view full screen needs a sandboxed browser account's live view",
  'ui/Accounts.tsx': 'Add account: a dialog as Forward to is',
  'ui/Attach.tsx': 'needs a file picked',
  'ui/ComposerMediaParts.tsx': 'the sticker and GIF pickers: a network that sends them',
  'ui/mail/ComposerCard.tsx': 'mail compose needs a mail account',
  'ui/Offline.tsx': 'shown only while the hub is out of reach',
  'ui/panel/Panel.tsx': "the phone's keyboard panel needs the Android app's keyboard",
  'ui/Sheet.tsx': "a phone's sheets: verify-phone.ts",
  'ui/Stories.tsx': 'stories: a network that has them',
  'ui/Viewer.tsx': 'the demo pictures open in the viewer on a phone: verify-phone.ts',
};
void UNCOVERED;

/** A fresh history each time: the app as opened from a link, its data in. */
async function start(h: string) {
  await p.goto(`${hub}/${h}`);
  await p.until(`!!document.querySelector('.pane') && !document.querySelector('.boot, .splash')`, 15000);
}

try {
  // ------------------------------------------------------------------ a computer
  await p.size(1280, 800);

  for (const c of PAGES) {
    for (const how of ['Escape', 'back'] as const) {
      await start(c.from);
      await nav(c.to);
      const was = await hash();
      if (c.focus) await p.eval(`document.querySelector(${JSON.stringify(c.focus)})?.focus()`);
      else await blur();
      if (how === 'Escape') await key('Escape');
      else await p.eval('history.back()');
      check(await hashIs(c.from), `${how} from ${c.name} goes back`, { was, now: await hash() });
    }
  }

  for (const r of ROOTS) {
    await start(r.at);
    const was = await hash();
    await blur();
    await key('Escape');
    await quiet();
    check((await hash()) === was, `Escape on ${r.view}'s list stays`, await hash());
  }

  // A half-written message: Escape leaves the page alone (and the draft).
  await start('#/inbox');
  await nav(`#/inbox/c/${dm.id}`);
  const composer = '.composer textarea, .composer [contenteditable]';
  await p.eval(`document.querySelector(${JSON.stringify(composer)})?.focus()`);
  await p.send('Input.insertText', { text: 'half a thought' });
  await key('Escape');
  await quiet();
  check(norm(await hash()) === norm(`#/inbox/c/${dm.id}`), 'Escape in a half-written message stays on the page', await hash());
  await p.eval(`(() => { const el = document.querySelector(${JSON.stringify(composer)}); el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); })()`);

  for (const c of LAYERS) {
    for (const how of ['Escape', 'back'] as const) {
      if (c.noLayer && how === 'back') continue;
      await start('#/inbox');
      await nav(c.at);
      const before = await hash();
      await blur();
      try {
        await c.open();
      } catch (err) {
        check(false, `${c.name} opens`, String(err));
        continue;
      }
      const opened = await wait(`${SHOWN} > 0${c.noLayer ? '' : ' && history.state?.layer !== undefined'}`);
      check(opened, `${c.name} opens${c.noLayer ? '' : ' as a layer'}`, { shown: await overlays() });
      if (shots) await p.shot(join(shots, `${c.file.replace(/\W/g, '-')}.png`));
      if (how === 'Escape') await key('Escape');
      else await p.eval('history.back()');
      check(await wait(`${SHOWN} === 0 && history.state?.layer === undefined`), `${how} closes ${c.name}`, { left: await overlays(), layer: await layerOpen() });
      await quiet();
      check((await hash()) === before, `and the page under ${c.name} stays`, await hash());
      // Its entry went with it: the next back leaves the page.
      await p.eval('history.back()');
      check(await wait(`decodeURIComponent(location.hash) !== ${JSON.stringify(before)}`), `then back leaves the page: no entry of ${c.name}'s left over`, await hash());
    }
  }

  // ------------------------------------------------------------------ a phone
  // A page goes over its list on a phone (pages.ts), and an address typed in puts the list under it: back lands there.
  await p.size(390, 844, true);
  for (const c of PAGES.filter((c) => !c.focus)) {
    await start(c.from);
    await nav(c.to);
    await p.eval('history.back()');
    const left = await wait(`decodeURIComponent(location.hash) !== ${JSON.stringify(norm(c.to))}`);
    check(left && (await hash()).startsWith('#/'), `on a phone, back from ${c.name} leaves it`, await hash());
  }
} catch (err) {
  check(false, 'ran to the end', String(err));
} finally {
  await b.close();
  await own?.stop();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
