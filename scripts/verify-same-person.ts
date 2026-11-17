/**
 * Same person? (docs/same-person.md), end to end against a demo hub in headless Chromium: the page opens from the People
 * header as a chunk of its own and lists the demo's pairs with their evidence; the browser hashes the pictures it is
 * sent; "Merge all over 90%…" opens a review whose ticks decide what is merged; Not the same hides a pair until Undo;
 * a profile shows its "Maybe the same person" card; the people graph draws suggestions as dashed links when asked;
 * and Settings → Adversarial features has the "Collect profiles" switch. It merges demo people: reset the demo after.
 *
 *   bun scripts/verify-same-person.ts http://127.0.0.1:8670 [/tmp/shots]
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8670';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const retention = (b: unknown) => fetch(`${hub}/api/retention`, { method: 'PUT', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const matches = () => fetch(`${hub}/api/matches`).then((r) => r.json()) as Promise<any>;
// Worked out afresh, so the list is the world as it is now (a demo reset rebuilds it in the background).
await fetch(`${hub}/api/matches/refresh`, { method: 'POST' });
let first = await matches();
for (let i = 0; i < 40 && (first.running || !first.at); i++) {
  await Bun.sleep(250);
  first = await matches();
}
const strong = first.suggestions.filter((s: any) => s.p >= 0.9);
check(strong.length >= 2, 'the demo has pairs over 90%', first.suggestions.map((s: any) => [s.a.name, s.b.name, s.p.toFixed(2)]));

const { page: p, close } = await launch();
const click = async (sel: string, text?: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0 && (${JSON.stringify(text ?? '')} === '' || x.textContent.includes(${JSON.stringify(text ?? '')}))); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel} ${text ?? ''}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const chunks = () => p.eval<string[]>(`performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).filter((n) => /\\.js$/.test(n))`);
const cards = () => p.eval<number>(`document.querySelectorAll('.sp-list > .sp-card').length`);

try {
  await p.size(1360, 900);
  await p.goto(`${hub}/#/people`);
  await p.until(`!!document.querySelector('.side-same')`, 15000);
  check(!(await chunks()).some((n) => n.startsWith('SamePerson')), 'the page is not loaded with the app');
  await click('.side-same');
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  check((await p.eval('location.hash')) === '#/people/same', 'the People header opens it', await p.eval('location.hash'));
  check((await chunks()).some((n) => n.startsWith('SamePerson')), 'as a chunk of its own');
  check((await cards()) === first.suggestions.length, 'one card per pair', { cards: await cards(), pairs: first.suggestions.length });
  const text = await p.eval<string>(`document.querySelector('.sp-list').innerText`);
  check(/profile links X ravi_routes/.test(text), 'why: a profile that links the other account');
  check(/phone number ending 0118/.test(text), 'why: a phone number in a bio, only its last digits shown');
  // The pictures: hashed in the page and sent back, until none wait.
  let after = first;
  for (let i = 0; i < 60 && after.picturesWaiting > 0; i++) {
    await Bun.sleep(250);
    after = await matches();
  }
  check(after.picturesWaiting === 0, 'the page hashed the pictures it was sent', after.picturesWaiting);
  await p.until(`!/Comparing pictures/.test(document.querySelector('.sp-status')?.textContent ?? '')`, 10000).catch(() => {});
  if (shots) await p.shot(`${shots}/same-person.png`);

  // Merge all over 90%: a review, each pair ticked; unticking one leaves it out.
  await click('.sp-controls .btn', 'Merge all over');
  await p.until(`!!document.querySelector('.sp-review')`, 3000);
  const rows = await p.eval<number>(`document.querySelectorAll('.sp-review-row').length`);
  check(rows === strong.length, 'the review lists every pair over 90%', { rows, strong: strong.length });
  check(await p.eval<boolean>(`[...document.querySelectorAll('.sp-review-row input')].every((i) => i.checked)`), 'each one ticked');
  if (shots) await p.shot(`${shots}/same-person-review.png`);
  await click('.sp-review-row input');
  const label = await p.eval<string>(`[...document.querySelectorAll('.modal .btn-row .btn')][0].textContent`);
  check(label.includes(`Merge ${strong.length - 1}`), 'unticking one leaves it out', label);
  await click('.modal .btn-row .btn', 'Cancel');
  await p.until(`!document.querySelector('.sp-review')`, 3000);

  // Not the same: the pair goes, Undo brings it back.
  const weak = first.suggestions.find((s: any) => s.p < 0.9);
  if (weak) {
    const before = await cards();
    await p.eval(`(() => { const c = [...document.querySelectorAll('.sp-card')].find((c) => c.innerText.includes(${JSON.stringify(weak.a.name)}) && !c.innerText.includes('profile links')); c.querySelector('.sp-actions .btn.ghost, .sp-actions button:nth-child(2)').click(); })()`);
    await p.until(`document.querySelectorAll('.sp-list > .sp-card').length === ${before - 1}`, 3000);
    const turned = (await matches()).suggestions.some((s: any) => s.key === weak.key);
    check(!turned, 'Not the same: the hub leaves the pair out');
    await click('.toast', 'Undo');
    // The toast's Undo resolves once the hub has worked the list out again; then the page loads it.
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      back = (await matches()).suggestions.some((s: any) => s.key === weak.key);
      if (!back) await Bun.sleep(250);
    }
    await p.until(`document.querySelectorAll('.sp-list > .sp-card').length === ${before}`, 5000).catch(() => {});
    check(back && (await cards()) === before, 'Undo brings it back, on the hub and on the page', { back, cards: await cards() });
  }

  // Groups (A~B and B~C) are one card: the demo has none, so this shows one made up in the page.
  await p.eval(`(() => {
    const f = window.__realFetch ??= window.fetch;
    window.fetch = async (u, ...a) => {
      const r = await f(u, ...a);
      if (!/\\/api\\/matches(\\?|$)/.test(String(u))) return r;
      const v = await r.clone().json();
      const s = v.suggestions.find((x) => x.a.name === 'Ravi');
      if (!s) return r;
      const c = { id: 'idn_madeup-tg', name: 'Ravi', identities: [{ id: 'idn_madeup-tg', network: 'telegram', handle: 'ravi_routes' }] };
      const ab = { ...s, key: s.b.id + '+idn_madeup-tg', a: s.b, b: c, p: 0.93, evidence: [{ kind: 'name', text: 'The same handle, ravi_routes (X and Telegram)', weight: 3.8 }] };
      v.suggestions.push(ab);
      v.groups = [{ sides: [s.a.id, s.b.id, c.id], keys: [s.key, ab.key], p: 0.93 }];
      return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    };
  })()`);
  await p.eval(`document.querySelector('[aria-label="Work it out again"]').click()`);
  await p.until(`!!document.querySelector('.sp-group')`, 10000);
  await click('.sp-controls .chip-btn', 'Groups');
  check((await p.eval<number>(`document.querySelectorAll('.sp-group').length`)) === 1, 'a group is one card');
  if (shots) await p.shot(`${shots}/same-person-group.png`);
  await p.eval(`window.fetch = window.__realFetch`);
  await click('.sp-controls .chip-btn', 'All');

  // A phone.
  await p.size(390, 844, true);
  await p.goto(`${hub}/#/people/same`);
  await p.eval('location.reload()');
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  const wide = await p.eval<number>(`document.documentElement.scrollWidth`);
  check(wide <= 390, 'on a phone, nothing wider than the screen', wide);
  if (shots) await p.shot(`${shots}/same-person-phone.png`);
  await p.size(1360, 900);

  // A profile's card.
  const lev = first.suggestions.find((s: any) => s.a.name === 'Lev');
  await p.goto(`${hub}/#/p/${encodeURIComponent(lev.b.id)}`);
  await p.until(`[...document.querySelectorAll('.card, section')].some((c) => c.textContent.includes('Maybe the same person'))`, 15000);
  const box = await p.eval<string>(`document.querySelector('.pf-same-row')?.innerText ?? ''`);
  check(/0118/.test(box), "a profile shows who may be the same person, and why", box.split('\n').slice(0, 4));
  if (shots) {
    await p.eval(`[...document.querySelectorAll('.pf-same-row')][0].scrollIntoView({ block: 'center' })`);
    await Bun.sleep(300);
    await p.shot(`${shots}/profile-same.png`);
  }

  // The graph: dashed links when asked, and the card says who. With server members on, both of Lev's accounts are on
  // it; collecting profiles goes on too, for Settings below.
  await retention({ adversarial: true, members: true, profiles: true });
  await fetch(`${hub}/api/demo/reset`, { method: 'POST' });
  // The demo's pairs each have one side in no place the graph draws (an X account, a Discord account in no shared
  // server): those are counted as off the graph. One made-up pair between two people on it shows the dashed link.
  const g = (await fetch(`${hub}/api/graph`).then((r) => r.json())) as any;
  const [ga, gb] = ['Jules', 'Noor'].map((n) => g.people.find((x: any) => x.name === n));
  // Pairs with a side the graph does not draw, as the hub has them now: the status line counts those.
  const onGraph = new Set(g.people.map((x: any) => x.id));
  await fetch(`${hub}/api/matches/refresh`, { method: 'POST' });
  let now = await matches();
  for (let i = 0; i < 40 && (now.running || !now.at); i++) {
    await Bun.sleep(250);
    now = await matches();
  }
  const offGraph = now.suggestions.filter((x: any) => !onGraph.has(x.a.id) || !onGraph.has(x.b.id)).length;
  await p.goto(`${hub}/#/people`);
  await p.until(`!!document.querySelector('.side-graph')`, 15000);
  await p.eval(`(() => {
    const f = window.__realFetch ??= window.fetch;
    window.fetch = async (u, ...a) => {
      const r = await f(u, ...a);
      if (!/\\/api\\/matches(\\?|$)/.test(String(u))) return r;
      const v = await r.clone().json();
      const side = (x) => ({ id: x.id, name: x.name, identities: [] });
      v.suggestions.push({ key: ${JSON.stringify(`${ga.id}+${gb.id}`)}, a: side(${JSON.stringify(ga)}), b: side(${JSON.stringify(gb)}), p: 0.71, evidence: [{ kind: 'picture', text: 'The same profile picture', weight: 3.2 }] });
      return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    };
  })()`);
  await click('.side-graph');
  await p.until(`!!document.querySelector('.pg-canvas canvas') && /Showing/.test(document.querySelector('.pg-showing')?.textContent ?? '')`, 15000);
  await click('.pg-controls .chip-btn', 'Same person?');
  await p.until(`/more off the graph/.test(document.querySelector('.pg-status')?.textContent ?? '')`, 10000).catch(() => {});
  const said = await p.eval<string>(`document.querySelector('.pg-status').textContent`);
  check(/[1-9]\d* possible same-person/.test(said), 'the graph says how many it draws', said);
  check(offGraph > 0 && new RegExp(`\\(${offGraph} more off the graph`).test(said), 'pairs with a side off the graph are counted as such', { said, offGraph });
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = 'Ravi'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.pg-hits .pg-row')`, 3000);
  await click('.pg-hits .pg-row');
  await p.until(`!!document.querySelector('.pg-same')`, 5000);
  check(/Ravi/.test(await p.eval<string>(`document.querySelector('.pg-same').innerText`)), 'the card: maybe the same as, someone off the graph too');
  await p.eval(`(() => { const i = document.querySelector('.pg-find input'); i.value = 'Jules'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.until(`[...document.querySelectorAll('.pg-hits .pg-row')].some((r) => r.textContent.includes('Jules'))`, 3000);
  await click('.pg-hits .pg-row', 'Jules');
  await p.until(`/Noor/.test(document.querySelector('.pg-same')?.innerText ?? '')`, 5000);
  check(true, 'the card: maybe the same as, someone on it');
  await p.until(`document.querySelector('.pg-canvas').dataset.settled === '1'`, 15000).catch(() => {});
  if (shots) await p.shot(`${shots}/graph-same.png`);

  // Settings → Adversarial features: the switch, with how collecting is going.
  await p.goto(`${hub}/#/settings`);
  await p.until(`!!document.getElementById('set-adversarial')`, 15000);
  const sw = await p.eval<string>(`[...document.querySelectorAll('#set-adversarial .toggle-row')].map((r) => r.innerText).find((t) => /Collect profiles/.test(t)) ?? ''`);
  check(!!sw, 'Adversarial features has Collect profiles', sw.split('\n')[0]);
  if (shots) {
    await p.eval(`[...document.querySelectorAll('#set-adversarial .toggle-row')].find((r) => /Collect profiles/.test(r.innerText)).scrollIntoView({ block: 'center' })`);
    await Bun.sleep(300);
    await p.shot(`${shots}/adversarial-profiles.png`);
  }

  await retention({ members: false, profiles: false, confirm: true });

  // Merge from the review: the pairs over 90% become one person each.
  await p.goto(`${hub}/#/people/same`);
  await p.until(`!!document.querySelector('.sp-card')`, 15000);
  await click('.sp-controls .btn', 'Merge all over');
  await p.until(`!!document.querySelector('.sp-review')`, 3000);
  await click('.modal .btn-row .btn', 'Merge');
  await p.until(`!document.querySelector('.sp-review')`, 10000);
  const left = await matches();
  check(!left.suggestions.some((s: any) => s.p >= 0.9), 'merged: none over 90% left', left.suggestions.map((s: any) => s.p.toFixed(2)));
  const people = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
  const ravi = (people.persons ?? people.people ?? []).filter((x: any) => x.name === 'Ravi');
  if (ravi.length) check(ravi.length === 1, 'one Ravi now', ravi.length);
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
