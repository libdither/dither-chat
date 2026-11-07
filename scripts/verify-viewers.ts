/**
 * The file viewers end to end (docs/files.md), in headless Chromium against a demo hub: the demo's text, code, Markdown,
 * JSON, CSV, ZIP, SVG and PDF files, each opened from its card, checked, and photographed at desktop width and at
 * 390 px; a card that updates by itself once the hub has looked at its file; a type with no viewer; and that nothing
 * a file says runs or loads on its own.
 *
 *   bun scripts/verify-viewers.ts http://127.0.0.1:8660 /tmp/viewers-verify [--probe-pdf]
 * The hub must be a demo hub (--demo) with its own data dir, started just before (the card that updates by itself
 * waits for the hub's first look, about 15 s after it starts). --probe-pdf also records what Chromium's own PDF viewer
 * does with the hub's /media PDF, in a tab and in a frame (docs/files.md says why the app uses pdf.js instead).
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type Page } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8660';
const dir = process.argv[3] ?? '/tmp/dither-viewers-verify';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const search = async (q: string) => ((await fetch(`${hub}/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json())) as any).hits[0]?.message;
const convRoute = (id: string) => {
  const c = boot.conversations.find((x: any) => x.id === id);
  return c?.spaceIds?.length ? `#/s/${c.spaceIds[0]}/c/${id}` : `#/c/${id}`;
};

let failures = 0;
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

interface Case {
  file: string;
  /** Text of the message it came with, to find its conversation. */
  q: string;
  kind: string;
  /** On the card, once the hub has looked. */
  facts: RegExp;
  /** True when the viewer shows what it should. */
  shows: string;
  what: string;
}
const CASES: Case[] = [
  { file: 'build-482.txt', q: 'full log', kind: 'text', facts: /^Text · 61 lines · 3 KB$/, shows: `document.querySelectorAll('.fv-code .fv-line').length === 61 && document.querySelector('.fv-code').textContent.includes('build #482 failed')`, what: 'plain text with line numbers' },
  { file: 'insert_get.rs', q: 'fixed test', kind: 'text', facts: /^Rust · 26 lines/, shows: `document.querySelectorAll('.fv-code .fv-line').length === 26 && [...document.querySelectorAll('.fv-code .hl-k')].some((e) => e.textContent === 'fn')`, what: 'Rust highlighted, though Discord called it application/rls-services+xml' },
  {
    file: 'routing-notes.md',
    q: 'write-up so far',
    kind: 'markdown',
    facts: /^Markdown · 35 lines/,
    shows: `(() => {
      const md = document.querySelector('.fv-md');
      return md && md.querySelector('h1')?.textContent === 'Greedy routing notes' && md.querySelectorAll('table tbody tr').length === 3
        && md.querySelectorAll('li.task input[type=checkbox]').length === 3 && md.querySelector('pre.fv-md-code .hl-k')
        && md.querySelector('a[href="https://example.org/greedy-embedding"][target=_blank]');
    })()`,
    what: 'Markdown rendered: headings, a table, task lists, highlighted code, a link',
  },
  { file: 'bench-483.json', q: 'benchmarks for', kind: 'json', facts: /^JSON · 34 lines/, shows: `document.querySelectorAll('.fv-json-toggle').length >= 4 && document.querySelector('.fv-json-tree').textContent.includes('Ryzen 7 7840U')`, what: 'JSON as a tree, though sent as application/octet-stream' },
  { file: 'stretch.csv', q: 'raw numbers', kind: 'csv', facts: /^CSV table · 5 lines/, shows: `document.querySelectorAll('.fv-table tbody tr').length === 4 && [...document.querySelectorAll('.fv-table td')].some((td) => td.textContent === '4-neighbour, wraps at the edges')`, what: 'CSV as a table, quoted commas kept in their cell' },
  { file: 'dither-sim-0.4.zip', q: 'release build', kind: 'archive', facts: /^ZIP archive · 6 entries/, shows: `document.querySelectorAll('.fv-archive tbody tr').length === 6 && document.querySelector('.fv-archive').textContent.includes('dither-sim-0.4/sim.js')`, what: 'the ZIP entry list' },
  { file: 'topology.svg', q: 'three-node picture', kind: 'text', facts: /^SVG image · 8 lines/, shows: `document.querySelector('.fv-code').textContent.includes("<script>alert('an SVG is shown as its source, never run')</script>") && [...document.querySelectorAll('.fv-code .hl-t')].some((e) => e.textContent === '<svg')`, what: 'SVG shown as its source' },
  {
    file: 'local-first-chat-sync.pdf',
    q: 'local-first-chat-sync',
    kind: 'pdf',
    facts: /^PDF · 1 page/,
    shows: `(() => {
      const c = document.querySelector('.fv-page canvas');
      if (!c || !c.width) return false;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) return true;
      return false;
    })()`,
    what: 'the PDF drawn by pdf.js (dark pixels on the page)',
  },
];

const b = await launch();
const p: Page = b.page;
const errorsAt = () => p.errors.length;
try {
  await p.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  const resources = () => p.eval<string[]>(`performance.getEntriesByType('resource').map((e) => e.name)`);
  const card = (name: string) => `[...document.querySelectorAll('.att-file')].find((a) => a.querySelector('b')?.textContent === ${JSON.stringify(name)})`;
  const facts = (name: string) => p.eval<string | null>(`${card(name)}?.querySelector('small')?.textContent ?? null`);

  // ---------------------------------------------------------------- a card that updates by itself
  await p.size(1280, 800);
  const benchMsg = await search('benchmarks for');
  await p.goto(`${hub}/${convRoute(benchMsg.conversationId)}`);
  await p.until(`!!${card('bench-483.json')}`, 15000);
  const before = await facts('bench-483.json');
  console.log(`     the card before the hub looks: ${before}`);
  try {
    await p.until(`/^JSON · 34 lines/.test(${card('bench-483.json')}?.querySelector('small')?.textContent ?? '')`, 45000);
    check(true, `the hub looked at the file by itself and the open card changed: ${await facts('bench-483.json')}`);
  } catch {
    check(false, `the card never showed what the hub found (still "${await facts('bench-483.json')}")`);
  }
  check(!(await resources()).some((r) => /JsonView|PdfView|pdf\.worker|MarkdownView/.test(r)), 'no viewer was loaded before a file was opened');

  // ---------------------------------------------------------------- each viewer
  for (const c of CASES) {
    const m = await search(c.q);
    if (!m) {
      check(false, `found the message for ${c.file}`);
      continue;
    }
    const att = m.attachments.find((a: any) => a.name === c.file);
    // The rest are looked at now, through the endpoint the viewer uses.
    const info = (await fetch(`${hub}/api/attachments/${att.id}/info`).then((r) => r.json())) as any;
    check(info.kind === c.kind, `${c.file}: the hub says ${info.mime} (${info.kind})`);
    for (const [w, h, mobile, tag] of [
      [1280, 800, false, 'desktop'],
      [390, 844, true, 'phone'],
    ] as const) {
      await p.size(w, h, mobile);
      await p.goto(`${hub}/${convRoute(m.conversationId)}`);
      await p.until(`!!${card(c.file)}`, 15000);
      if (tag === 'desktop') {
        await p.until(`${JSON.stringify(c.facts.source)} && new RegExp(${JSON.stringify(c.facts.source)}).test(${card(c.file)}.querySelector('small').textContent)`, 8000).catch(() => {});
        const f = await facts(c.file);
        check(c.facts.test(f ?? ''), `${c.file}: the card says "${f}"`);
      }
      await p.eval(`${card(c.file)}.scrollIntoView({ block: 'center' })`);
      await p.shot(join(dir, `card-${c.file.replace(/\W+/g, '-')}-${tag}.png`));
      const errs = errorsAt();
      await p.eval(`${card(c.file)}.click()`);
      await p.until(`document.querySelector('.fviewer')?.dataset.kind === ${JSON.stringify(c.kind)}`, 10000);
      try {
        await p.until(c.shows, 15000);
        check(true, `${c.file} (${tag}): ${c.what}`);
      } catch {
        check(false, `${c.file} (${tag}): ${c.what}`);
      }
      const head = await p.eval<{ download: string | null; name: string }>(`({ download: document.querySelector('.fviewer-bar a[aria-label="Download"]')?.getAttribute('href') ?? null, name: document.querySelector('.fviewer-name b')?.textContent })`);
      if (tag === 'desktop') check(head.download?.startsWith('/media/') && head.name === c.file, `${c.file}: the header has its name and Download`);
      if (tag === 'phone') {
        const over = await p.eval<{ page: number; viewer: number; bar: number; w: number }>(
          `({ page: document.scrollingElement.scrollWidth, viewer: document.querySelector('.fviewer').scrollWidth, bar: document.querySelector('.fviewer-bar').scrollWidth - document.querySelector('.fviewer-bar').clientWidth, w: innerWidth })`,
        );
        check(over.page <= over.w && over.viewer <= over.w && over.bar <= 0, `${c.file} (phone): nothing wider than the screen (page ${over.page}, viewer ${over.viewer}, of ${over.w})`);
      }
      await p.shot(join(dir, `${c.file.replace(/\W+/g, '-')}-${tag}.png`));
      check(p.errors.length === errs, `${c.file} (${tag}): no page errors${p.errors.length > errs ? ': ' + p.errors.slice(errs).join(' | ') : ''}`);
      await p.eval(`document.querySelector('.fviewer-bar button[aria-label="Close"]').click()`);
      await p.until(`!document.querySelector('.fviewer')`, 3000);
    }
  }

  // ---------------------------------------------------------------- nothing in a file runs or loads by itself
  await p.size(1280, 800);
  const md = await search('write-up so far');
  await p.goto(`${hub}/${convRoute(md.conversationId)}`);
  await p.until(`!!${card('routing-notes.md')}`, 15000);
  await p.eval(`window.__alerted = false; window.alert = () => (window.__alerted = true);`);
  await p.eval(`${card('routing-notes.md')}.click()`);
  await p.until(`!!document.querySelector('.fv-md h1')`, 10000);
  const safe = await p.eval<{ scripts: number; imgs: string[]; raw: boolean; load: string | null; alerted: boolean }>(`({
    scripts: document.querySelectorAll('.fviewer script, .fviewer iframe, .fviewer object, .fviewer embed').length,
    imgs: [...document.querySelectorAll('.fviewer img')].map((i) => i.src),
    raw: document.querySelector('.fv-md').textContent.includes("<script>alert('nope')</script>") && document.querySelector('.fv-md').textContent.includes('<img src=x onerror=alert(1)>'),
    load: document.querySelector('.fv-md-load')?.textContent ?? null,
    alerted: window.__alerted,
  })`);
  check(safe.scripts === 0 && !safe.alerted, 'Markdown: no script, frame or object in the page, nothing ran');
  check(safe.raw, 'Markdown: raw HTML is shown as text');
  check(safe.imgs.length === 0 && !(await resources()).some((r) => r.startsWith('https://example.org')), `Markdown: the remote picture is not loaded ("${safe.load}" waits for a click)`);
  await p.eval(`document.querySelector('.fviewer-bar button[aria-label="Close"]').click()`);

  const svg = await search('three-node picture');
  await p.goto(`${hub}/${convRoute(svg.conversationId)}`);
  await p.until(`!!${card('topology.svg')}`, 15000);
  await p.eval(`${card('topology.svg')}.click()`);
  await p.until(`!!document.querySelector('.fv-code')`, 10000);
  const svgSafe = await p.eval<{ svgs: number; alerted: boolean }>(`({ svgs: [...document.querySelectorAll('.fviewer-body svg')].filter((s) => !s.classList.contains('icon')).length, alerted: window.__alerted })`);
  check(svgSafe.svgs === 0 && !svgSafe.alerted, 'SVG: never rendered, its script never ran');
  await p.eval(`document.querySelector('.fviewer-bar button[aria-label="Close"]').click()`);

  // ---------------------------------------------------------------- no viewer: today's behaviour
  const house = boot.conversations.find((c: any) => c.name === 'Housemates');
  await p.goto(`${hub}/${convRoute(house.id)}`);
  await p.until(`!!${card('rent-split.xlsx')}`, 15000);
  const page = (await fetch(`${hub}/api/conversations/${house.id}/messages`).then((r) => r.json())) as any;
  const xlsx = page.messages.flatMap((x: any) => x.attachments).find((a: any) => a.name === 'rent-split.xlsx');
  await fetch(`${hub}/api/attachments/${xlsx.id}/info`);
  await p.goto(`${hub}/${convRoute(house.id)}`);
  await p.until(`/Excel spreadsheet/.test(${card('rent-split.xlsx')}?.querySelector('small')?.textContent ?? '')`, 10000).catch(() => {});
  check(/^Excel spreadsheet · \d+ B$/.test((await facts('rent-split.xlsx')) ?? ''), `a file with no viewer says what it is: "${await facts('rent-split.xlsx')}"`);
  const dl = await p.eval<{ href: string; download: string | null }>(`(() => { const a = ${card('rent-split.xlsx')}; return { href: a.getAttribute('href'), download: a.getAttribute('download') }; })()`);
  await p.eval(`${card('rent-split.xlsx')}.click()`);
  await Bun.sleep(500);
  check(!(await p.eval(`!!document.querySelector('.fviewer')`)) && dl.href.startsWith('/media/') && dl.download === 'rent-split.xlsx', 'and a click on it is a download, as before, not a viewer');
  await p.shot(join(dir, 'no-viewer-card.png'));

  const errors = p.errors;
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

  // ---------------------------------------------------------------- the browser's own PDF viewer, for the record
  if (process.argv.includes('--probe-pdf')) {
    const pdf = (await search('local-first-chat-sync')).attachments[0];
    const viewers = async () => ((await fetch(`http://127.0.0.1:${b.port}/json`).then((r) => r.json())) as any[]).filter((t) => /^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai/.test(t.url)).length;
    await p.size(1280, 800);
    await p.goto(hub + pdf.url);
    await Bun.sleep(2500);
    await p.shot(join(dir, 'probe-pdf-tab.png'));
    const inTab = await viewers();
    const tabBody = await p.eval<string>(`document.body?.innerHTML.slice(0, 200) ?? ''`).catch(() => '(no access)');
    await p.goto(`${hub}/#/`);
    await p.until(`!!document.querySelector('.att-file, .inbox, main')`, 15000).catch(() => {});
    await p.eval(`(() => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(pdf.url)}; f.style.cssText = 'position:fixed;left:40px;top:40px;width:800px;height:600px;z-index:9999;background:#fff;border:2px solid red'; document.body.appendChild(f); })()`);
    await Bun.sleep(3000);
    await p.shot(join(dir, 'probe-pdf-frame.png'));
    // The tab's viewer went with the tab: any viewer now is the frame's.
    const inFrame = await viewers();
    console.log(`     probe: the PDF in a tab of its own: ${inTab ? 'the PDF viewer ran' : 'no PDF viewer'} (${tabBody.replace(/\s+/g, ' ').slice(0, 120) || 'no page script access'})`);
    console.log(`     probe: the PDF in a frame of the app's page: ${inFrame ? 'the PDF viewer ran' : 'no PDF viewer target'}; see probe-pdf-*.png`);
  }
} finally {
  await b.close();
}
console.log(`\nscreenshots in ${dir}`);
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
