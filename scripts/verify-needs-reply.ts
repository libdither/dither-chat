/**
 * "Needs a reply" on the page (docs/inbox.md, "Needs a reply"), in headless Chromium against a demo hub:
 *
 * - Each inbox row with ↩ shows the hub's chance faintly after the age, and says it as the ↩'s tooltip ("Likely needs
 *   a reply: 60%"); hovering the ↩ button says it before "No reply needed".
 * - The row's menu ("Why it's here") ends the owed reason with the same words.
 * - How it sorts has a "Needs a reply" block: nothing to check on a fresh hub, or, with `--seed`, invented predictions
 *   and outcomes written to the demo hub's own database, a Brier score and a table of shown against answered.
 * - The same on a phone's width.
 *
 *   bun scripts/verify-needs-reply.ts http://127.0.0.1:8491 [/tmp/shots] [--seed <demo data dir>/hub.sqlite]
 *
 * The hub must be a demo hub (--demo) with a data dir of its own: --seed writes to it.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const argv = process.argv.slice(2);
const seedAt = argv.indexOf('--seed');
const seed = seedAt >= 0 ? argv.splice(seedAt, 2)[1] : null;
const hub = argv[0] ?? 'http://127.0.0.1:8491';
const shots = argv[1];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const pct = (p: number) => `${Math.round(p * 100)}%`;
const label = (p: number) => `${p >= 0.5 ? 'Likely needs a reply' : 'May need a reply'}: ${pct(p)}`;

if (seed) {
  // Invented predictions over the last ten days, answered about as often as they said, on invented conversations.
  const db = new Database(seed);
  let s = 7;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const now = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < 160; i++) {
    const cid = `cnv_verify${i}`;
    const addressed = now - (4 + r() * 10) * 86_400_000;
    const p = Math.round((0.05 + 0.9 * r()) * 20) / 20;
    const answered = r() < p * 0.95 + 0.03;
    db.query('INSERT OR IGNORE INTO needs_prediction (conversation_id, addressed, age, p, table_p, at) VALUES (?, ?, ?, ?, ?, ?)').run(cid, addressed, 3_600_000, p, Math.min(0.95, p + 0.1), addressed + 3_600_000);
    db.query('INSERT OR IGNORE INTO owed_turn (conversation_id, addressed, shape, author_key, answered_at, timed, dismissed) VALUES (?, ?, ?, ?, ?, 1, 0)').run(cid, addressed, 'direct', `verify${i % 9}`, answered ? addressed + 2 * 3_600_000 : null);
  }
  db.exec('COMMIT');
  db.close();
}

const views = new Map<string, any>(((await fetch(`${hub}/api/attention`).then((r) => r.json())) as any).items.map((v: any) => [v.id, v]));
const { page: p, close } = await launch();
try {
  await p.size(1280, 800);
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('.sidebar .inbox-row.owes .row-owed[data-p]').length > 0`, 15000);
  const rows = await p.eval<{ key: string; p: string | null; title: string | null; aria: string | null; button: string | null }[]>(
    `[...document.querySelectorAll('.sidebar .inbox-row.owes')].map((el) => { const o = el.querySelector('.row-owed'); const b = el.querySelector('.row-mark'); return { key: el.dataset.rowKey ?? el.parentElement?.dataset.rowKey ?? '', p: o?.dataset.p ?? null, title: o?.title || null, aria: o?.getAttribute('aria-label'), button: b?.title ?? null }; })`,
  );
  const plain = rows.filter((x) => x.key.startsWith('cnv_') && views.get(x.key)?.needsReply != null);
  check(plain.length > 0, 'rows with ↩ carry the hub’s chance', { rows: rows.length, withChance: plain.length });
  for (const x of plain.slice(0, 5)) {
    const v = views.get(x.key).needsReply as number;
    check(x.p === pct(v) && x.title === label(v) && x.aria?.endsWith(label(v)) && x.button === `${label(v)}. Click: No reply needed`, `a row shows ${pct(v)}, its tooltip and its ↩ button say "${label(v)}"`, x);
  }
  const faint = await p.eval<{ content: string; opacity: string }>(
    `(() => { const s = getComputedStyle(document.querySelector('.sidebar .row-owed[data-p]'), '::after'); return { content: s.content, opacity: s.opacity }; })()`,
  );
  check(/^"\d+%"$/.test(faint.content) && Number(faint.opacity) < 1, 'the percentage is drawn faint after the age, with no element of its own', faint);
  if (shots) await p.shot(`${shots}/inbox.png`);

  // The row's menu: "Why it's here" ends the owed reason with the chance.
  const target = plain.find((x) => views.get(x.key).reasons[0]?.includes('needs a reply') || views.get(x.key).reasons[0]?.includes('need a reply'));
  if (target) {
    const [x, y] = await p.eval<[number, number]>(`(() => { const el = document.querySelector('[data-row="${target.key}"]'); el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
    await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await Bun.sleep(300);
    const text = await p.eval<string>(`document.querySelector('.cm')?.textContent ?? ''`);
    check(text.includes(label(views.get(target.key).needsReply)), 'the row’s menu says it in "Why it’s here"');
    if (shots) await p.shot(`${shots}/row-menu.png`);
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  } else check(false, 'a row whose first reason is the owed one');

  // How it sorts, from a fresh load.
  await p.goto('about:blank');
  await p.goto(`${hub}/#/model`);
  await p.until(`!!document.querySelector('[data-needs="calibration"]')`, 15000);
  const block = await p.eval<{ text: string; bins: number }>(`(() => { const b = document.querySelector('[data-needs="calibration"]'); b.scrollIntoView({ block: 'start' }); return { text: b.textContent, bins: b.querySelectorAll('.needs-bins tbody tr').length }; })()`);
  const cal = (await fetch(`${hub}/api/attention/needs-reply`).then((r) => r.json())) as any;
  if (cal.n) check(block.text.includes(`Brier score ${cal.brier.toFixed(3)}`) && block.bins === cal.bins.filter((b: any) => b.n).length, 'How it sorts shows the Brier score and the bins', { n: cal.n, bins: block.bins });
  else check(block.text.includes('Nothing to check yet'), 'How it sorts: nothing to check yet on a fresh hub');
  await Bun.sleep(200);
  if (shots) await p.shot(`${shots}/how-it-sorts.png`);

  // A phone.
  await p.size(390, 844, true);
  await p.goto('about:blank');
  await p.goto(`${hub}/#/inbox`);
  await p.until(`document.querySelectorAll('.inbox-row.owes .row-owed[data-p]').length > 0`, 15000);
  const overflow = await p.eval<number>(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  check(overflow <= 0, 'on a phone the row fits, with no sideways scroll', { overflow });
  if (shots) await p.shot(`${shots}/phone-inbox.png`);
  check(p.errors.length === 0, 'no page errors', p.errors.slice(0, 3));
} finally {
  await close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
