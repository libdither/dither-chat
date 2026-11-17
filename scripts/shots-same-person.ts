/**
 * Screenshots of Same person? and the people graph on the crowd demo (docs/same-person.md), and what it found: start a
 * hub with `DITHER_DEMO_SCENARIO=crowd bun run hub -- --demo --adversarial --data <temp dir> --port <port>`, then
 *
 *   bun scripts/shots-same-person.ts http://127.0.0.1:PORT /tmp/shots
 *
 * The page hashes the pictures first, so the picture pairs are found; the list it prints is each pair with its chance
 * and evidence. Changes nothing but the pictures' hashes.
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3] ?? '/tmp/same-person-shots';
mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const matches = () => fetch(`${hub}/api/matches`).then((r) => r.json()) as Promise<any>;
const settled = async () => {
  await fetch(`${hub}/api/matches/refresh`, { method: 'POST' });
  let m = await matches();
  for (let i = 0; i < 80 && (m.running || !m.at); i++) {
    await Bun.sleep(250);
    m = await matches();
  }
  return m;
};
await fetch(`${hub}/api/retention`, { method: 'PUT', body: JSON.stringify({ adversarial: true, members: true }), headers: { 'content-type': 'application/json' } });

const { page: p, close } = await launch();
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${text ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const find = async (name: string) => {
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`[...document.querySelectorAll('.pg-hits .pg-row')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`, 3000);
  await click('.pg-hits .pg-row', name);
  await p.until(`!!document.querySelector('.pg-same')`, 5000).catch(() => {});
};
const graphSettled = () => p.until(`document.querySelector('.pg-canvas')?.dataset.settled === '1'`, 20000).catch(() => {});

try {
  await settled();
  await p.size(1360, 900);
  // The page hashes the pictures it is sent; then a run with them.
  await p.goto(`${hub}/#/people/same`);
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  for (let i = 0; i < 80 && (await matches()).picturesWaiting > 0; i++) await Bun.sleep(250);
  const m = await settled();
  for (const s of m.suggestions) console.log(`${String(Math.round(s.p * 100)).padStart(3)}%  ${s.a.name} | ${s.b.name}  ::  ${s.evidence.map((e: any) => `${e.text} (${e.weight.toFixed(1)})`).join('; ')}`);
  console.log(`groups: ${m.groups.length}, pictures waiting: ${m.picturesWaiting}`);
  await p.eval('location.reload()');
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  await Bun.sleep(400);
  await p.shot(`${shots}/same-person.png`);
  await p.eval(`document.querySelector('.sp-list').lastElementChild.scrollIntoView({ block: 'end' })`);
  await Bun.sleep(300);
  await p.shot(`${shots}/same-person-weak.png`);
  // The fainter pairs, on asking.
  console.log(`fainter: ${(m.faint ?? []).map((s: any) => `${Math.round(s.p * 100)}% ${s.a.name} | ${s.b.name} (${s.evidence.map((e: any) => e.kind).join(', ')})`).join('; ')}`);
  if ((m.faint ?? []).length) {
    await click('.sp-faint');
    await p.until(`/Hide the fainter/.test(document.querySelector('.sp-faint')?.textContent ?? '')`, 3000);
    await p.eval(`document.querySelector('.sp-faint').scrollIntoView({ block: 'end' })`);
    await Bun.sleep(300);
    await p.shot(`${shots}/same-person-faint.png`);
  }

  // The graph: everyone, then with the suggestions drawn, then one pair picked.
  await p.goto(`${hub}/#/people`);
  await p.until(`!!document.querySelector('.side-graph')`, 15000);
  await click('.side-graph');
  await p.until(`!!document.querySelector('.pg-canvas canvas') && /Showing/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  await graphSettled();
  await p.shot(`${shots}/graph-crowd.png`);
  await click('.pg-controls .chip-btn', 'Same person?');
  await Bun.sleep(600);
  await graphSettled();
  console.log('graph:', await p.eval<string>(`document.querySelector('.pg-status')?.textContent ?? ''`));
  await p.shot(`${shots}/graph-crowd-same.png`);
  for (const who of ['nightjar', 'kestrel']) {
    await find(who);
    await Bun.sleep(500);
    await p.shot(`${shots}/graph-${who}.png`);
  }

  // A phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/people/same`);
  await p.eval('location.reload()');
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  await Bun.sleep(400);
  await p.shot(`${shots}/same-person-phone.png`);
} finally {
  await close();
}
