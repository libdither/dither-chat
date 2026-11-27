/**
 * Screenshots of a profile's Voice card and In common's People (who they are tied to), and the graph's Why card and Voice
 * together weight, on the demo (docs/profile.md "Voice", "People in common"): start a hub with `bun run hub -- --demo --adversarial --data <temp dir> --port <port>`, then
 *
 *   bun scripts/shots-voice.ts http://127.0.0.1:PORT /tmp/shots
 *
 * Changes nothing.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3] ?? '/tmp/voice-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const mara = boot.identities.find((i: any) => i.network === 'discord' && i.displayName === 'Mara');
if (!mara) throw new Error('no Mara in the demo');

const { page: p, close } = await launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${text ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
try {
  for (const [w, h, mobile, name] of [
    [1360, 1000, false, 'profile'],
    [400, 860, true, 'profile-phone'],
  ] as const) {
    await p.size(w, h, mobile);
    await p.goto(`${hub}/#/${mara.personId ? `p/${mara.personId}` : `i/${mara.id}`}`);
    await p.until(`!!document.querySelector('.pf-voice-h')`, 20000);
    await p.until(`!!document.querySelector('.pf-common .pf-tie')`, 20000).catch(() => {});
    await Bun.sleep(500);
    await p.eval(`[...document.querySelectorAll('h2, h3')].find((e) => e.textContent.trim().startsWith('Voice'))?.scrollIntoView({ block: 'start' })`);
    await Bun.sleep(300);
    await p.shot(`${shots}/${name}-voice.png`);
    await p.eval(`document.querySelector('.pf-common')?.scrollIntoView({ block: 'start' })`);
    await Bun.sleep(300);
    await p.shot(`${shots}/${name}-close.png`);
  }
  // The graph: Mara picked, her Why card naming who she is tied to by voice; then the tuning panel's Voice together.
  await p.size(1360, 900);
  await p.goto(`${hub}/#/people/graph`);
  await p.until(`!!document.querySelector('.pg-canvas canvas')`, 20000);
  await p.until(`document.querySelector('.pg-canvas')?.dataset.settled === '1'`, 20000).catch(() => {});
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = 'Mara'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`[...document.querySelectorAll('.pg-hits .pg-row')].some((r) => r.textContent.includes('Mara'))`, 5000);
  await click('.pg-hits .pg-row', 'Mara');
  await p.until(`/\\(voice\\)/.test(document.querySelector('.pg-why')?.textContent ?? '')`, 20000);
  await Bun.sleep(500);
  await p.shot(`${shots}/graph-why.png`);
  await click('.pg-why-how');
  await p.until(`[...document.querySelectorAll('.pg-tune-row b')].some((b) => b.textContent === 'Voice together')`, 5000);
  await p.eval(`[...document.querySelectorAll('.pg-tune-row b')].find((b) => b.textContent === 'Voice together').scrollIntoView({ block: 'center' })`);
  await Bun.sleep(300);
  await p.shot(`${shots}/graph-tuning.png`);
} finally {
  await close();
}
