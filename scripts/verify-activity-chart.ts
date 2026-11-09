/**
 * A profile's Activity chart (docs/profile.md "Activity"), end to end against a demo hub in headless Chromium: Sam's
 * page draws their messages as bars and yours mirrored under them, says when they're usually around, and shows exact
 * numbers on hover; the 7 / 30 / 90 days toggle redraws it; the weekday-by-hour grid has a cell per hour of the week.
 * With adversarial features shown (a hub started with --adversarial), their presence is a band under the bars and their
 * status changes are marks above them; without, neither is drawn and a line says where to turn them on, which opens
 * Settings at Adversarial features. On a desktop in the dark theme and a phone in the light one.
 *
 *   bun scripts/verify-activity-chart.ts http://127.0.0.1:8880 [/tmp/shots]
 * The hub must be a fresh demo hub (--demo, with or without --adversarial).
 */
import { mkdirSync } from 'node:fs';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8880';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });
const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const sam = boot.persons.find((x: any) => x.name === 'Sam Rivera');
if (!sam) throw new Error('the demo world lacks Sam Rivera');
const r = (await fetch(`${hub}/api/retention`).then((x) => x.json())) as any;
const gate = r.adversarial && r.presence && r.statuses;
const tag = gate ? 'adversarial' : 'plain';
console.log(`a ${tag} demo hub`);

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const { page: p, close } = await launch();
const tz = await p.eval<string>(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
const api = (days: number) => fetch(`${hub}/api/people/${sam.id}/activity?days=${days}&tz=${encodeURIComponent(tz)}`).then((x) => x.json()) as Promise<any>;
const theme = async (name: string, hash: string) => {
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: ${JSON.stringify(name)} }))`);
  await p.eval(`(location.hash = ${JSON.stringify(hash)}, location.reload())`).catch(() => {});
  await Bun.sleep(800);
  await p.until(`!!document.querySelector('.app')`, 15000);
};
const chart = () => p.until(`!!document.querySelector('.act-timeline svg') && !document.querySelector('.act-loading')`, 10000);
const pick = async (days: number) => {
  await p.eval(`[...document.querySelectorAll('.act-range .chip-btn')].find((b) => b.textContent.trim() === '${days} days').click()`);
  await Bun.sleep(150);
  await chart();
};
/** The middle of an element's box, in page coordinates. */
const box = (expr: string) => p.eval<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = ${expr}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
const hover = (x: number, y: number) => p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const sum = (series: any[] | undefined, from: number, to: number) => (series ?? []).reduce((a: number, s: any) => a + s.hours.slice(from, to).reduce((x: number, y: number) => x + y, 0), 0);

try {
  await p.goto(`${hub}/#/p/${sam.id}`);
  await p.until(`!!document.querySelector('.app')`, 15000);
  for (const [w, h, name] of [[1360, 900, 'dither-dark'], [390, 844, 'dither-light']] as const) {
    const where = `${w < 500 ? 'phone' : 'desktop'} ${name}`;
    await p.size(w, h, w < 500);
    await theme(name, `#/p/${sam.id}`);
    await p.eval(`localStorage.removeItem('dither.activityDays')`);
    await p.until(`!!document.querySelector('.pf-activity-card')`, 10000);
    await chart();
    await pick(30);
    const v30 = await api(30);
    const head = await p.eval<string>(`document.querySelector('.pf-activity-card h3').innerText`);
    check(/activity/i.test(head), `${where}: the section is Activity`, head);
    const status = await p.eval<string>(`document.querySelector('.pf-activity-card .pf-status-now')?.innerText ?? ''`);
    check(await p.eval<boolean>(`!!document.querySelector('.pf-activity-card .pf-status-now + .act')`) && /Offline|Online|Idle|Do not disturb/.test(status) === gate, `${where}: the status, and presence when logged, at the top`, status);
    const bars = await p.eval<{ them: number; you: number }>(`({ them: document.querySelectorAll('.act-bar.them').length, you: document.querySelectorAll('.act-bar.you').length })`);
    const days30 = v30.sent.reduce((a: number, s: any) => a + s.count, 0);
    check(bars.them > 5 && bars.you > 3 && days30 > 20, `${where}: 30 days of their messages as bars, yours under the axis`, { ...bars, messages: days30 });
    const summary = await p.eval<string>(`document.querySelector('.act-summary').innerText`);
    check(/^Usually around \d+(am|pm)–\d+(am|pm); \d+ messages and \d+ reactions in 30 days, mostly in DMs\. You sent \d+ messages where they are\./.test(summary), `${where}: the summary in words`, summary);
    const band = await p.eval<number>(`document.querySelectorAll('.act-pres').length`);
    const marks = await p.eval<number>(`document.querySelectorAll('.act-mark-dot').length`);
    const note = await p.eval<string>(`document.querySelector('.act-gate')?.innerText ?? ''`);
    if (gate) {
      check(band > 10 && marks === v30.statuses.length && marks >= 2 && !note, `${where}: presence as a band and status changes as marks, no note`, { band, marks, note });
      check(summary.includes('% of the time logged'), `${where}: and how much of the logged time they were online`, summary);
      const legend = await p.eval<string>(`document.querySelector('.act-legend').innerText`);
      check(['Them', 'You, where they are', 'Online', 'Idle', 'Do not disturb', 'Offline', 'Status change'].every((x) => legend.includes(x)), `${where}: a legend for every mark`, legend);
    } else {
      check(band === 0 && marks === 0 && /appear once presence and statuses are turned on in\s*Settings → Adversarial features/.test(note), `${where}: no band, no marks, and a line saying where to turn them on`, { band, marks, note });
      check(!('presence' in v30) && !('statuses' in v30) && !('online' in v30.week), `${where}: the hub sends neither, not zeros`, Object.keys(v30));
    }

    // The busiest day's bar: its number on hover.
    const theirs = Array.from({ length: 30 }, (_, d) => sum(v30.sent, d * 24, d * 24 + 24));
    const best = theirs.indexOf(Math.max(...theirs));
    const plot = await box(`document.querySelector('.act-timeline svg')`);
    await hover(plot!.x - plot!.w / 2 + ((best + 0.5) * plot!.w) / 30, plot!.y);
    await Bun.sleep(150);
    const tip = await p.eval<string>(`document.querySelector('.act-tip')?.innerText ?? ''`);
    const mine = sum(v30.mine, best * 24, best * 24 + 24);
    check(tip.includes(`${theirs[best]}\nfrom them`) || tip.includes(`${theirs[best]} from them`), `${where}: hovering the busiest day shows its count`, { tip: tip.split('\n'), want: theirs[best] });
    check(tip.includes(`${mine}`) && tip.includes('from you'), `${where}: and yours`, mine);
    if (shots) await p.shot(`${shots}/activity-${tag}-${w < 500 ? 'phone' : 'desktop'}-hover.png`);
    if (w < 500) {
      // A tap on a phone: the tapped day, not today.
      await hover(2, 2);
      const x = plot!.x - plot!.w / 2 + ((best + 0.5) * plot!.w) / 30;
      for (const type of ['touchStart', 'touchEnd'] as const) await p.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: plot!.y }] });
      await Bun.sleep(200);
      const tapped = await p.eval<string>(`document.querySelector('.act-tip')?.innerText ?? ''`);
      check(tapped.includes(`${theirs[best]}\nfrom them`) || tapped.includes(`${theirs[best]} from them`), `${where}: a tap on the busiest day shows its count`, tapped.split('\n').slice(0, 3));
    }

    if (gate) {
      const mark = await box(`document.querySelector('.act-mark-hit')`);
      await hover(mark!.x, mark!.y);
      await Bun.sleep(150);
      const mt = await p.eval<string>(`document.querySelector('.act-tip')?.innerText ?? ''`);
      check(mt.includes('rest week') && mt.includes('Status changed'), `${where}: a status mark shows the status on hover`, mt.split('\n'));
    }
    await hover(2, 2);

    // The toggle.
    await pick(7);
    const seven = await p.eval<{ label: string; n: number; ticks: string[] }>(
      `({ label: document.querySelector('.act-timeline svg').getAttribute('aria-label'), n: document.querySelectorAll('.act-bar.them').length, ticks: [...document.querySelectorAll('.act-timeline .act-tick')].map((t) => t.textContent) })`,
    );
    if (shots) {
      await p.eval(`document.querySelector('.act-range').scrollIntoView({ block: 'start' })`);
      await p.shot(`${shots}/activity-${tag}-${w < 500 ? 'phone' : 'desktop'}-7days.png`);
    }
    check(/^Messages per (hour|\d+ hours)\./.test(seven.label) && seven.ticks.some((t) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+$/.test(t)), `${where}: 7 days in hours, days named`, { label: seven.label.slice(0, 30), ticks: seven.ticks.slice(0, 4) });
    await pick(90);
    const ninety = await p.eval<{ label: string; summary: string }>(`({ label: document.querySelector('.act-timeline svg').getAttribute('aria-label'), summary: document.querySelector('.act-summary').innerText })`);
    check(ninety.label.startsWith('Messages per day.') && ninety.summary.includes('in 90 days'), `${where}: 90 days by day`, ninety.summary);
    check((await p.eval<string | null>(`localStorage.getItem('dither.activityDays')`)) === '90', `${where}: the range is remembered`);
    await pick(30);

    // When they're around: a cell per hour of the week, and its number.
    const cells = await p.eval<number>(`document.querySelectorAll('.act-heat .act-cell').length`);
    const tabs = await p.eval<string[]>(`[...document.querySelectorAll('.act-week-head .chip-btn')].map((b) => b.textContent.trim())`);
    check(cells === 168 && tabs.join() === (gate ? 'Their messages,Yours,Online' : 'Their messages,Yours'), `${where}: the weekday-by-hour grid and what it can show`, { cells, tabs });
    const busiest = v30.week.sent.indexOf(Math.max(...v30.week.sent));
    const cell = await box(`document.querySelectorAll('.act-heat .act-cell')[${busiest}]`);
    await hover(cell!.x, cell!.y);
    await Bun.sleep(150);
    const ct = await p.eval<string>(`document.querySelector('.act-week .act-tip')?.innerText ?? ''`);
    check(ct.includes(`${v30.week.sent[busiest]}`) && ct.includes('in 30 days'), `${where}: hovering the busiest hour of the week shows its count`, ct.split('\n'));
    if (gate) {
      await p.eval(`[...document.querySelectorAll('.act-week-head .chip-btn')].find((b) => b.textContent.trim() === 'Online').click()`);
      await Bun.sleep(150);
      check(await p.eval<boolean>(`!!document.querySelector('.act-heat.online') && document.querySelectorAll('.act-heat .act-cell:not(.l0)').length > 10`), `${where}: the grid shows when they were online`);
    }
    if (shots) {
      await p.eval(`document.querySelector('.pf-activity-card').scrollIntoView({ block: 'start' })`);
      await hover(2, 2);
      await Bun.sleep(150);
      await p.shot(`${shots}/activity-${tag}-${w < 500 ? 'phone' : 'desktop'}.png`);
    }
    const fit = await p.eval<{ sw: number; w: number; card: number; svg: number }>(
      `({ sw: document.querySelector('.pf-scroll').scrollWidth, w: document.querySelector('.pf-scroll').clientWidth, card: document.querySelector('.pf-activity-card').getBoundingClientRect().width, svg: document.querySelector('.act-timeline svg').getBoundingClientRect().width })`,
    );
    check(fit.sw <= fit.w + 1 && fit.svg <= fit.card, `${where}: it fits the width`, fit);
    // The table view.
    await p.eval(`document.querySelector('.act-sub:not(.pf-status-history):not(.pf-presence-history) > summary').click()`);
    await Bun.sleep(150);
    const rows = await p.eval<number>(`document.querySelectorAll('.act-table tbody tr').length`);
    check(rows === 30, `${where}: the numbers by day as a table`, rows);
  }

  if (!gate) {
    await p.eval(`document.querySelector('.act-gate .link-btn').scrollIntoView()`);
    await p.eval(`document.querySelector('.act-gate .link-btn').click()`);
    await p.until(`location.hash === '#/settings' && !!document.getElementById('set-adversarial')`, 8000);
    check(true, 'the line opens Settings at Adversarial features');
  }
  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
