/**
 * Screenshots of the in-call icon (docs/calls.md "In a call now") on the demo, where Lev, Mara and Alice are in the
 * hangout voice channel: Alice's DM row in the inbox and her row on People, at a computer's width and a phone's. Start
 * a hub with `bun run hub -- --demo --adversarial --data <temp dir> --port <port>`, then
 *
 *   bun scripts/shots-in-call.ts http://127.0.0.1:PORT /tmp/shots [--before]
 *
 * Unless `--before` (a build from before the icon), it then checks the icon follows the voice channel live: a `voice`
 * frame with Alice gone takes it off her row, and one with her back puts it back, without a reload. Changes nothing on
 * the hub: the frames go to the page's own socket handler.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3] ?? '/tmp/in-call-shots';
const before = process.argv.includes('--before');
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const voice = (await fetch(`${hub}/api/voice`).then((r) => r.json())) as { channels: { conversationId: string; members: { identityId: string }[] }[] };
const alice = boot.persons.find((p: any) => p.name === 'Alice Chen');
if (!alice) throw new Error('no Alice in the demo');
const hangout = voice.channels.find((c) => c.members.some((m) => alice.identityIds.includes(m.identityId)));
if (!hangout) throw new Error('Alice is in no voice channel: a demo from before the seed');

const { page: p, close } = await launch();
// Every socket the page opens, so the live check can hand its handler a frame.
await p.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => { const W = window.WebSocket; window.__socks = []; window.WebSocket = function (...a) { const s = new W(...a); window.__socks.push(s); return s; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }); })()`,
});
const row = (sel: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((r) => r.getBoundingClientRect().width > 0 && r.textContent.includes('Alice'))`;
const show = async (sel: string, file: string) => {
  await p.until(`!!${row(sel)}`, 20000);
  if (!before) await p.until(`!!${row(sel)}?.querySelector('[data-voice-now]')`, 10000);
  await p.eval(`${row(sel)}.scrollIntoView({ block: 'center' })`);
  await p.until(`document.fonts.status === 'loaded'`, 5000);
  await p.shot(`${shots}/${file}.png`);
  return p.eval<string | null>(`${row(sel)}?.querySelector('[data-voice-now]')?.getAttribute('title') ?? null`);
};
/** A `voice` frame to the page's live socket, as the hub sends one. */
const frame = (members: { identityId: string }[]) =>
  p.eval(`(() => { const s = window.__socks.filter((x) => x.readyState === 1 && typeof x.onmessage === 'function').at(-1); s.onmessage(new MessageEvent('message', { data: ${JSON.stringify(JSON.stringify([{ t: 'voice', channels: [{ ...hangout, members, at: Date.now(), status: null }] }]))} })); })()`);

try {
  for (const [w, h, mobile, name] of [
    [1360, 900, false, 'desktop'],
    [400, 860, true, 'phone'],
  ] as const) {
    await p.size(w, h, mobile);
    await p.goto(`${hub}/#/`);
    console.log(`${name} inbox:`, await show('.conv-row[data-row]', `${name}-inbox${before ? '-before' : ''}`));
    await p.goto(`${hub}/#/people`);
    console.log(`${name} people:`, await show('[data-person]', `${name}-people${before ? '-before' : ''}`));
  }
  if (!before) {
    const mark = `${row('[data-person]')}?.querySelector('[data-voice-now]')`;
    await frame(hangout.members.filter((m) => !alice.identityIds.includes(m.identityId)));
    await p.until(`!${mark}`, 5000);
    await frame(hangout.members);
    await p.until(`!!${mark}`, 5000);
    console.log('live: the icon left with Alice and came back with her');
  }
} finally {
  await close();
}
