/**
 * Screenshots of a Zulip organization on the demo world (hub/src/demo-zulip.ts, docs/threads.md "Zulip"): the sidebar's
 * topics, a channel's topic list, its details panel, the resolved topics' tab, a topic with a moved message, and a
 * profile with a time zone. Start a hub with
 * `DITHER_DEMO_SCENARIO=zulip bun run hub -- --demo --data <temp dir> --port <port>`, then
 *
 *   bun scripts/shots-zulip.ts http://127.0.0.1:PORT /tmp/shots
 *
 * Changes nothing on the hub.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3] ?? '/tmp/zulip-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const host = 'chat.example.org';
const conv = (nativeId: string) => {
  const c = boot.conversations.find((x: any) => x.network === 'zulip' && x.nativeId === nativeId);
  if (!c) throw new Error(`no conversation ${nativeId}: start the hub with DITHER_DEMO_SCENARIO=zulip`);
  return c;
};
const space = boot.spaces.find((s: any) => s.network === 'zulip' && s.nativeId === host);
const design = conv(`${host}/s/10`);
const tokens = conv(`${host}/s/10/t/color%20tokens`);
const release = conv(`${host}/s/12/t/v2.4`);
const ada = boot.identities.find((i: any) => i.network === 'zulip' && i.nativeId === `${host}/u/11`);
const e = encodeURIComponent;

const { page: p, close } = await launch();
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${text ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const settle = () => Bun.sleep(500);

try {
  await p.size(1360, 860);
  // The channel's page: the sidebar's topics under it, and its list of topics.
  await p.goto(`${hub}/#/s/${e(space.id)}/c/${e(design.id)}`);
  await p.until(`!!document.querySelector('.forum-post')`, 15000);
  await settle();
  await p.shot(`${shots}/channel.png`);
  // Its details panel.
  await click('button[aria-label="Details"]');
  await p.until(`!!document.querySelector('.details')`, 5000);
  await settle();
  await p.shot(`${shots}/details.png`);
  await click('button[aria-label="Details"]');
  // The resolved (archived) topics, asked of the network.
  await click('.forum-bar .btn.ghost');
  await p.until(`!!document.querySelector('.thread-browser') && !document.querySelector('.thread-browser .pf-hint')?.textContent?.includes('…')`, 5000);
  await settle();
  await p.shot(`${shots}/browser.png`);
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  // A topic, then the one with a moved message.
  await p.goto(`${hub}/#/s/${e(space.id)}/c/${e(tokens.id)}`);
  await p.until(`!!document.querySelector('.msg')`, 15000);
  await settle();
  await p.shot(`${shots}/topic.png`);
  await p.goto(`${hub}/#/s/${e(space.id)}/c/${e(release.id)}`);
  await p.until(`!!document.querySelector('.msg')`, 15000);
  await settle();
  await p.shot(`${shots}/moved.png`);
  // A profile with a time zone.
  await p.goto(`${hub}/#/i/${e(ada.id)}`);
  await p.until(`[...document.querySelectorAll('.pf-facts, dl, .facts')].some((x) => /Time zone|Local time/.test(x.textContent))`, 15000);
  await settle();
  await p.shot(`${shots}/profile.png`);
  if (p.errors.length) console.log('page errors:', p.errors.join('\n'));
} finally {
  await close();
}
