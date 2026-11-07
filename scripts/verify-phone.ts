/**
 * The phone layout, exercised with real touch input in a 390x844 mobile emulation: the panel pager, swipe to
 * reply, long-press and its sheet, dragging sheets away, the back button, the keyboard, the image viewer, pull
 * to refresh, and no sideways overflow on any main screen. Run it against a demo hub, never a real one:
 *
 *   bun scripts/verify-phone.ts http://127.0.0.1:8470 [docs/screenshots]
 *
 * With a directory, it also saves the phone screenshots numbered from 36.
 * Headless Chromium is not a phone: no real keyboard, no iOS Safari, and frame timing means little here.
 */
import { launch, type Page } from './browser.ts';

const [base, shots] = process.argv.slice(2);
if (!base) throw new Error('usage: bun scripts/verify-phone.ts <hub url> [screenshot dir]');

const { page, close } = await launch();
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const shot = async (name: string) => {
  if (shots) await page.shot(`${shots}/${name}.png`);
};

// ------------------------------------------------------------------ touch

type Pt = [number, number];
const touch = (type: string, pts: Pt[]) =>
  page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 6, radiusY: 6, force: 1 })) });
async function tap([x, y]: Pt) {
  await touch('touchStart', [[x, y]]);
  await Bun.sleep(40);
  await touch('touchEnd', []);
  await Bun.sleep(350);
}
async function press([x, y]: Pt, ms = 650) {
  await touch('touchStart', [[x, y]]);
  await Bun.sleep(ms);
  await touch('touchEnd', []);
  await Bun.sleep(300);
}
/** A finger from a to b in `steps` moves `ms` apart, with `mid` run halfway while it is still down. */
async function swipe(a: Pt, b: Pt, opts: { steps?: number; ms?: number; mid?: () => Promise<void>; hold?: boolean } = {}) {
  const steps = opts.steps ?? 14;
  await touch('touchStart', [a]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [[a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]]);
    await Bun.sleep(opts.ms ?? 16);
    if (i === Math.ceil(steps / 2) && opts.mid) await opts.mid();
  }
  if (!opts.hold) await touch('touchEnd', []);
  await Bun.sleep(450);
}
/** The middle of the first element matching, scrolled into view. */
async function at(sel: string, pick = 'el => true'): Promise<Pt> {
  const r = await page.eval(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(${pick});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
  })()`);
  if (!r) throw new Error(`nothing matches ${sel}`);
  await Bun.sleep(150);
  return r;
}
const state = () => page.eval<{ hash: string; cls: string; transform: string; layer: unknown; under?: string }>(
  `({ hash: location.hash, cls: document.querySelector('.app').className.replace(/\\s+/g, ' ').trim(), transform: document.querySelector('.center').style.transform, layer: history.state?.layer, under: document.querySelector('.app').dataset.under })`,
);
const has = (sel: string) => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const back = async () => {
  await page.eval('history.back()');
  await Bun.sleep(500);
};

// ------------------------------------------------------------------ layout checks

/** What scrolls sideways on purpose: rows of chips, code, logs. Anything else that does is a bug. */
const SIDEWAYS = '.level-picker, .ident-chips, .composer-files, .sheet-quick, pre, code, .log-view, .detail-dump, .lv-screen';
/**
 * Anything in view that scrolls sideways when it should not, or runs past the right edge of the screen and
 * so is cut off. Fine inside something meant to scroll sideways, inside the card while it is moved aside, and
 * in text that ends in an ellipsis or fades out on purpose.
 */
async function overflow(): Promise<string[]> {
  return page.eval(`(() => {
    const W = innerWidth, out = [], sideways = ${JSON.stringify(SIDEWAYS)};
    if (document.scrollingElement.scrollWidth > W + 1) out.push('document ' + document.scrollingElement.scrollWidth);
    const moved = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).transform !== 'none') return true; return false; };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.left >= W || r.right <= 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const name = (el.className && typeof el.className === 'string' ? el.className : el.tagName).trim();
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.matches(sideways) && !moved(el)) out.push(name + ' scrolls sideways by ' + (el.scrollWidth - el.clientWidth));
      if (r.right <= W + 1 || cs.position === 'fixed') continue;
      let fine = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.transform !== 'none' || (p !== el && p.matches(sideways))) { fine = true; break; }
        if (ps.textOverflow === 'ellipsis' || ps.maskImage !== 'none' || ps.webkitMaskImage !== 'none') { fine = true; break; }
      }
      if (!fine) out.push(name + ' right=' + Math.round(r.right));
    }
    return [...new Set(out)].slice(0, 8);
  })()`);
}
/** overflow() at every screenful of a scrolling pane, top to bottom; the pane's scroll is put back after. */
async function overflowThrough(scroller: string): Promise<string[]> {
  const n = await page.eval<number>(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); return el ? Math.ceil((el.scrollHeight - el.clientHeight) / (el.clientHeight * 0.8)) : -1; })()`);
  if (n < 0) return [`no ${scroller}`];
  const found = new Set<string>();
  const reverse = await page.eval<boolean>(`getComputedStyle(document.querySelector(${JSON.stringify(scroller)})).flexDirection === 'column-reverse'`);
  for (let i = 0; i <= n; i++) {
    await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(scroller)}); el.scrollTop = ${reverse ? -1 : 1} * ${i} * el.clientHeight * 0.8; })()`);
    await Bun.sleep(60);
    for (const o of await overflow()) found.add(o);
  }
  await page.eval(`document.querySelector(${JSON.stringify(scroller)}).scrollTop = 0`);
  return [...found];
}
/** Buttons in view whose touch area is under `min` px either way, counting a ::after that widens it. */
async function smallTargets(scope: string, min = 40): Promise<string[]> {
  return page.eval(`(() => {
    const out = [];
    for (const el of document.querySelectorAll(${JSON.stringify(scope)} + ' :is(button, a, input, select, [role=link], .row, .chan)')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (el.closest('.msg-body, .crumbs, .reactions')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || el.disabled) continue;
      const after = getComputedStyle(el, '::after');
      const grow = after.content !== 'none' && after.position === 'absolute' ? -2 * Math.min(parseFloat(after.top) || 0, 0) : 0;
      if (r.height + grow < ${min} || r.width + grow < Math.min(${min}, 32)) out.push((el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24) || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return [...new Set(out)].slice(0, 12);
  })()`);
}

// ------------------------------------------------------------------ the run

try {
  await page.size(390, 844, true);
  // A notch and a home indicator, where this Chromium can pretend to have them.
  const insets = await page.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34, left: 0, right: 0 } }).then(() => true, () => false);
  await page.goto(`${base}/#/inbox`);
  await page.until(`!!document.querySelector('.app.phone')`, 15000);
  await Bun.sleep(800);
  check('touch emulation makes a coarse pointer', await page.eval(`matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches`));
  const viewport = await page.eval<string>(`document.querySelector('meta[name=viewport]').content`);
  check('viewport asks for the keyboard to resize the layout', viewport.includes('interactive-widget=resizes-content'), viewport);
  if (insets) check('safe areas: the list starts below the notch', (await page.eval<number>(`document.querySelector('.side-head').getBoundingClientRect().top`)) >= 47);
  else console.log('SKIP  safe-area emulation is not available in this Chromium');

  // Home: rail, list, tab bar.
  let s = await state();
  check('home shows the rail, the list and the tab bar', s.cls.includes('tabs') && (await has('.app > .rail')) && (await page.eval(`getComputedStyle(document.querySelector('.tabbar')).display !== 'none'`)), s.cls);
  check('no sideways overflow: home', !(await overflow()).length, await overflow());
  check('tap targets: tab bar and rail', !(await smallTargets('.tabbar, .rail')).length, await smallTargets('.tabbar, .rail'));
  check('tap targets: list rows', !(await smallTargets('.sidebar')).length, await smallTargets('.sidebar'));
  check('the Home and Triage tabs carry their counts', await page.until(`document.querySelectorAll('.tab .tab-badge').length >= 2`, 4000).then(() => true, () => false));
  await shot('36-phone-home');

  // Open a conversation with a tap.
  await tap(await at('.sidebar .conv-row', `el => el.querySelector('.row-title')?.textContent.trim() === 'dev'`));
  await page.until(`location.hash.includes('/c/')`);
  await Bun.sleep(700);
  s = await state();
  const conv = s.hash;
  check('a tap opens the conversation as a card over the list', s.cls.includes('rest-open') && s.transform === 'none' && !s.cls.includes('tabs'), s);
  check('no sideways overflow: conversation, all the way up', !(await overflowThrough('.timeline-scroll')).length, await overflowThrough('.timeline-scroll'));
  check('tap targets: conversation header and composer', !(await smallTargets('.conv-head, .composer')).length, await smallTargets('.conv-head, .composer'));
  await shot('37-phone-conversation');

  // Swipe right: the card follows the finger, then settles beside the list.
  let mid = '';
  await swipe([30, 420], [300, 430], {
    mid: async () => {
      mid = (await state()).transform;
      await shot('38-phone-swipe-back');
    },
  });
  const px = Number(mid.match(/translateX\(([\d.]+)px\)/)?.[1] ?? 0);
  check('swipe right: the card tracks the finger', px > 100 && px < 200, mid);
  s = await state();
  check('swipe right: back to the list, with the conversation peeking at the edge', !s.hash.includes('/c/') && s.cls.includes('rest-peek') && s.cls.includes('tabs'), s);
  check('no sideways overflow: list beside the peeking card', !(await overflow()).length, await overflow());
  await shot('39-phone-peek');

  // Swipe left on the list: the page comes back.
  await swipe([300, 500], [40, 500]);
  s = await state();
  check('swipe left beside the peeking card brings the conversation back', s.hash === conv && s.cls.includes('rest-open'), s);

  // A short, slow swipe goes back to where it was.
  await swipe([30, 420], [110, 420], { steps: 10, ms: 40 });
  s = await state();
  check('a short slow swipe settles back', s.hash === conv && s.cls.includes('rest-open') && s.transform === 'none', s);
  // A short fast flick commits.
  await swipe([30, 420], [120, 420], { steps: 4, ms: 8 });
  s = await state();
  check('a short fast flick commits on its velocity', !s.hash.includes('/c/') && s.cls.includes('rest-peek'), s);
  await tap([370, 400]);
  s = await state();
  check('tapping the peeking edge brings the conversation back', s.hash === conv && s.cls.includes('rest-open'), s);

  // Swipe left on the header: the details panel.
  await swipe([330, 75], [40, 80]);
  s = await state();
  check('swipe left reveals the details panel', s.cls.includes('rest-details') && s.under === 'details' && s.layer !== undefined, s);
  check('no sideways overflow: details panel', !(await overflowThrough('.det-scroll')).length, await overflowThrough('.det-scroll'));
  await shot('40-phone-details');
  await back();
  s = await state();
  check('back closes the details panel and stays in the conversation', s.hash === conv && s.cls.includes('rest-open') && s.layer === undefined, s);
  await swipe([330, 75], [40, 80]);
  await swipe([120, 400], [370, 400]);
  s = await state();
  check('swipe right on the details panel closes it', s.hash === conv && s.cls.includes('rest-open') && s.layer === undefined, s);

  // Searching this conversation is a page of it, with the way back.
  await tap(await at('.conv-head .hdr-btn[aria-label="Search in this conversation"]'));
  s = await state();
  check('search in this conversation opens as a page with a back button', s.hash.startsWith('#/search') && s.cls.includes('rest-open') && !s.cls.includes('tabs') && (await page.eval(`getComputedStyle(document.querySelector('.search-back')).display !== 'none'`)), s);
  await swipe([6, 420], [330, 420]);
  s = await state();
  check('…and swiping back returns to the conversation', s.hash === conv && s.cls.includes('rest-open'), s);

  // Swipe a message left to reply.
  const msg = await at('.msg', `el => el.textContent.includes('fixed in')`);
  await swipe([msg[0] + 80, msg[1]], [msg[0] - 60, msg[1] + 4], {
    steps: 12,
    mid: async () => {
      await shot('41-phone-swipe-reply');
    },
  });
  check('swipe a message left to reply', await page.eval(`!!document.querySelector('.composer-reply') && document.querySelector('.composer-reply').textContent.includes('Lev')`));
  check('the card did not move for a reply swipe', (await state()).cls.includes('rest-open'));
  await tap(await at('.composer-reply .icon-btn'));

  // Long-press: the action sheet carries what the hover bar and tooltips do.
  await press(await at('.msg', `el => el.textContent.includes('fixed in')`));
  check('long-press opens the message sheet', await has('.sheet-layer .cm-sheet'));
  const actions = await page.eval<string>(`[...document.querySelectorAll('.cm-sheet .sheet-action, .cm-sheet .sheet-quick button')].map(b => b.getAttribute('aria-label') || b.textContent.trim()).join(' | ')`);
  check('the sheet has reply, react, copy, profile and the time', ['Reply', 'Copy Text', 'Profile', 'Add Reaction'].every((w) => actions.includes(w)) && (await page.eval(`/\\d{4}/.test(document.querySelector('.msg-sheet-head small').textContent)`)), actions);
  check('the sheet is a layer the back button closes', (await state()).layer !== undefined);
  await shot('42-phone-message-sheet');
  const grip = await page.eval<Pt>(`(() => { const b = document.querySelector('.sheet .sheet-grip').getBoundingClientRect(); return [b.x + b.width / 2, b.y + 4]; })()`);
  await swipe(grip, [grip[0], grip[1] + 300], { steps: 10 });
  check('dragging the grabber down dismisses the sheet', !(await has('.sheet-layer')));
  s = await state();
  check('…and gives back its history entry', s.layer === undefined && s.hash === conv, s);

  // A finger that long-pressed and then slides does not drag the page under the sheet.
  const held = await at('.msg', `el => el.textContent.includes('fixed in')`);
  await touch('touchStart', [held]);
  await Bun.sleep(600);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[held[0] + i * 20, held[1]]]);
    await Bun.sleep(16);
  }
  await touch('touchEnd', []);
  await Bun.sleep(400);
  s = await state();
  check('sliding after a long-press leaves the page where it is', (await has('.sheet-layer')) && s.hash === conv && s.transform === 'none', s);
  await back();

  // Copy from the sheet raises a toast; a toast flicks away sideways.
  await press(await at('.msg', `el => el.textContent.includes('fixed in')`));
  await tap(await at('.cm-sheet .sheet-action', `el => el.textContent.includes('Copy Text')`));
  await page.until(`!!document.querySelector('.toast')`, 3000).catch(() => {});
  check('copying a message says so in a toast at the top', await page.eval(`(() => { const t = document.querySelector('.toast'); return !!t && t.getBoundingClientRect().top < 120; })()`));
  if (await has('.toast')) {
    const t = await at('.toast');
    await swipe(t, [t[0] + 260, t[1]], { steps: 8 });
    check('a toast flicked sideways goes away', !(await has('.toast')));
  }

  // A sheet dragged a little springs back.
  await press(await at('.msg', `el => el.textContent.includes('fixed in')`));
  const grip2 = await page.eval<Pt>(`(() => { const b = document.querySelector('.sheet .sheet-grip').getBoundingClientRect(); return [b.x + b.width / 2, b.y + 4]; })()`);
  await swipe(grip2, [grip2[0], grip2[1] + 40], { steps: 8, ms: 40 });
  check('a sheet dragged a little springs back', (await has('.sheet-layer')) && (await page.eval(`!document.querySelector('.sheet').style.transform`)));
  // Back closes the sheet before it leaves the conversation.
  await back();
  s = await state();
  check('back closes the sheet first', !(await has('.sheet-layer')) && s.hash === conv, s);
  await back();
  s = await state();
  check('then back leaves the conversation', !s.hash.includes('/c/') && s.cls.includes('rest-peek'), s);
  await page.eval('history.forward()');
  await Bun.sleep(500);
  check('forward opens it again', (await state()).hash === conv);

  // A menu is a sheet on a phone.
  await tap(await at('.conv-head .hdr-btn.level'));
  check('the notification menu opens as a sheet', await has('.sheet-layer .sheet-menu .level-menu'));
  await shot('47-phone-menu-sheet');
  await tap(await at('.sheet-layer'), );
  await Bun.sleep(300);
  check('tapping outside the sheet closes it', !(await has('.sheet-layer')));

  // The image viewer: pinch, double-tap, swipe down.
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(500);
  await tap(await at('.sidebar .conv-row', `el => el.textContent.includes('Climbing')`));
  await page.until(`!!document.querySelector('.att-img')`);
  await Bun.sleep(500);
  await tap(await at('.att-img'));
  check('tapping an image opens the viewer', await has('.viewer .viewer-img'));
  await Bun.sleep(250);
  await shot('43-phone-image-viewer');
  await touch('touchStart', [[170, 420], [220, 430]]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [[170 - i * 10, 420 - i * 8], [220 + i * 10, 430 + i * 8]]);
    await Bun.sleep(16);
  }
  await touch('touchEnd', []);
  await Bun.sleep(400);
  const zoom = await page.eval<string>(`document.querySelector('.viewer-img').style.transform`);
  check('pinch zooms the image, within its limit', Number(zoom.match(/scale\(([\d.]+)\)/)?.[1] ?? 1) > 1.5 && Number(zoom.match(/scale\(([\d.]+)\)/)?.[1] ?? 9) <= 5, zoom);
  for (let i = 0; i < 2; i++) {
    await touch('touchStart', [[195, 420]]);
    await Bun.sleep(30);
    await touch('touchEnd', []);
    await Bun.sleep(90);
  }
  await Bun.sleep(350);
  check('double-tap zooms back out', (await page.eval<string>(`document.querySelector('.viewer-img').style.transform`)).includes('scale(1)'));
  await swipe([195, 400], [200, 700], { steps: 8 });
  await Bun.sleep(300);
  check('swiping down dismisses the viewer', !(await has('.viewer')));
  check('…and the conversation is still open', (await state()).hash.includes('/c/'));

  // Long-press a reaction: who reacted, as a sheet.
  await press(await at('.reaction:not(.add)'));
  check('long-press on a reaction shows who reacted, as a sheet', await has('.sheet.reactors .reactor'));
  await back();
  check('…and back closes it', !(await has('.sheet-layer')));

  // Edge swipe back from a profile opened from a message.
  const convWithImage = (await state()).hash;
  await tap(await at('.msg .avatar-btn'));
  await page.until(`location.hash.startsWith('#/p/') || location.hash.startsWith('#/i/')`);
  await Bun.sleep(900);
  check('no sideways overflow: profile, top to bottom', !(await overflowThrough('.pf-scroll')).length, await overflowThrough('.pf-scroll'));
  await shot('52-phone-profile');
  await swipe([6, 400], [330, 400]);
  await Bun.sleep(300);
  s = await state();
  check('edge swipe goes back from the profile to the conversation', s.hash === convWithImage && s.cls.includes('rest-open'), s);

  // Keyboard: the composer stays above it.
  const ta = await at('.composer textarea');
  await tap(ta);
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 520, deviceScaleFactor: 2, mobile: true });
  await Bun.sleep(400);
  let box = await page.eval<{ bottom: number; h: number; focused: boolean }>(`(() => { const b = document.querySelector('.composer-box').getBoundingClientRect(); return { bottom: b.bottom, h: innerHeight, focused: document.activeElement.tagName === 'TEXTAREA' && document.documentElement.classList.contains('kb-open') }; })()`);
  check('a resized layout (Android keyboard) keeps the composer right above it', box.focused && box.bottom <= box.h && box.bottom > box.h - 30, box);
  await shot('50-phone-keyboard');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await Bun.sleep(300);
  // iOS shrinks only the visual viewport and scrolls it. Pretend to be that.
  await page.eval(`(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 480 });
    Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, get: () => 0 });
    visualViewport.dispatchEvent(new Event('resize'));
  })()`);
  await Bun.sleep(200);
  box = await page.eval(`(() => { const b = document.querySelector('.composer-box').getBoundingClientRect(); return { bottom: b.bottom, h: 480, focused: document.documentElement.classList.contains('kb-open') }; })()`);
  check('a shrunk visual viewport (iOS keyboard) keeps the composer right above it', box.bottom <= 480 && box.bottom > 450 && box.focused, box);
  await page.eval(`(() => { delete visualViewport.height; delete visualViewport.offsetTop; document.activeElement.blur(); visualViewport.dispatchEvent(new Event('resize')); })()`);
  await Bun.sleep(200);
  check('the app takes the full height back when the keyboard goes', (await page.eval<number>(`document.getElementById('app').getBoundingClientRect().height`)) === 844);
  // On a touch keyboard Enter is a new line; the button sends.
  await page.eval(`document.querySelector('.composer textarea').focus()`);
  await page.send('Input.insertText', { text: 'line one' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await Bun.sleep(100);
  check('Enter on a touch keyboard makes a new line instead of sending', (await page.eval<string>(`document.querySelector('.composer textarea').value`)).includes('\n'));
  await page.eval(`(() => { const t = document.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); })()`);

  // Pull to refresh on a list.
  await page.goto(`${base}/#/people`);
  await Bun.sleep(600);
  const fetched = await page.eval<number>(`performance.getEntriesByType('resource').filter(e => e.name.includes('/api/bootstrap')).length`);
  await swipe([220, 260], [220, 520], { steps: 14, ms: 20, hold: true, mid: async () => {} });
  check('pulling the list down shows the refresh indicator', await page.eval(`document.querySelector('.ptr').classList.contains('armed')`));
  await shot('53-phone-pull-to-refresh');
  await touch('touchEnd', []);
  await page.until(`performance.getEntriesByType('resource').filter(e => e.name.includes('/api/bootstrap')).length > ${fetched}`, 4000).then(
    () => check('letting go refreshes from the hub', true),
    () => check('letting go refreshes from the hub', false),
  );

  // Arranging: hold a rail item for its menu, as a sheet.
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(500);
  await press(await at('.rail-scroll .rail-item[data-dnd-key^="space:"] .rail-btn'), 700);
  check('holding a rail entry opens its arrange sheet', await has('.sheet-layer .cm-sheet'));
  await shot('48-phone-place-menu');
  await back();
  check('back closes it', !(await has('.sheet-layer')));

  // Tabs: triage, search, you; and the account page from there.
  await tap(await at('.tab', `el => el.textContent.includes('Triage')`));
  s = await state();
  check('the Triage tab shows the board with the tab bar', s.hash === '#/triage' && s.cls.includes('tab-root') && s.cls.includes('tabs'), s);
  check('no sideways overflow: triage', !(await overflowThrough('.board-scroll')).length, await overflowThrough('.board-scroll'));
  check('mark all read is reachable on a phone', await page.eval(`[...document.querySelectorAll('.board-head .btn')].some(b => b.textContent.includes('Mark all read') && b.getBoundingClientRect().right <= innerWidth)`));
  await shot('44-phone-triage');
  await tap(await at('.tab', `el => el.textContent.includes('Search')`));
  check('the Search tab shows search with its filters', (await state()).hash.startsWith('#/search') && (await has('.search-filters')));
  await page.eval(`document.querySelector('.search-main input').focus()`);
  await page.send('Input.insertText', { text: 'route' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  check('a search finds messages', await page.until(`!!document.querySelector('.search-hit')`, 5000).then(() => true, () => false));
  await page.eval(`document.activeElement?.blur()`);
  await page.eval(`document.querySelector('.search-main input').focus()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 520, deviceScaleFactor: 2, mobile: true });
  await Bun.sleep(300);
  check('typing on a tab, the tab bar gives way to the keyboard', await page.eval(`getComputedStyle(document.querySelector('.tabbar')).display === 'none'`));
  await page.eval(`document.activeElement?.blur()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await Bun.sleep(300);
  check('no sideways overflow: search results', !(await overflow()).length, await overflow());
  await shot('51-phone-search');
  await tap(await at('.tab', `el => el.textContent.includes('You')`));
  check('the You tab lists the accounts first', await has('#set-accounts .acc-link'));
  check('no sideways overflow: settings, top to bottom', !(await overflowThrough('.settings-scroll')).length, await overflowThrough('.settings-scroll'));
  check('tap targets: settings', !(await smallTargets('.settings-scroll')).length, await smallTargets('.settings-scroll'));
  await shot('45-phone-you');
  await tap(await at('#set-accounts .acc-link'));
  await Bun.sleep(400);
  s = await state();
  check('an account opens from settings', s.hash.startsWith('#/accounts/') && s.cls.includes('rest-open'), s);
  check('no sideways overflow: account page', !(await overflowThrough('.account-scroll')).length, await overflowThrough('.account-scroll'));
  await shot('46-phone-account');
  await swipe([6, 400], [330, 400]);
  s = await state();
  check('swipe back from the account returns to settings', s.hash === '#/settings' && s.cls.includes('tab-root'), s);

  // A dialog is a sheet: Add account, dragged away by its header.
  await tap(await at('#set-accounts .btn'));
  check('Add account opens as a bottom sheet', await page.eval(`(() => { const m = document.querySelector('.modal'); return !!m && Math.abs(m.getBoundingClientRect().bottom - innerHeight) < 2; })()`));
  await shot('54-phone-dialog-sheet');
  const head = await at('.modal .sheet-grip');
  await swipe([head[0], head[1]], [head[0], head[1] + 400], { steps: 10 });
  check('dragging the dialog down closes it', !(await has('.modal')));

  // All communities, and its categories dialog.
  await page.goto(`${base}/#/directory`);
  await Bun.sleep(600);
  check('no sideways overflow: all communities', !(await overflowThrough('.dir-scroll')).length, await overflowThrough('.dir-scroll'));
  await shot('49-phone-directory');

  // Reduced motion: still follows the finger, but settles at once.
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(500);
  await tap(await at('.sidebar .conv-row'));
  await Bun.sleep(300);
  await swipe([30, 420], [300, 420]);
  check('with reduced motion the card settles without a transition', await page.eval(`(() => { const t = document.querySelector('.center').style.transition; return !t || t === 'none'; })()`));
  await page.send('Emulation.setEmulatedMedia', { features: [] });

  // Light theme, for one look.
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'light' }))`);
  await page.goto(`${base}/#/inbox`);
  await Bun.sleep(400);
  await page.eval(`location.reload()`);
  await page.until(`!!document.querySelector('.app.phone')`, 15000);
  await Bun.sleep(700);
  await tap(await at('.sidebar .conv-row', `el => el.textContent.includes('Climbing')`));
  await Bun.sleep(700);
  await shot('55-phone-light');
  await page.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dark' }))`);

  check('no script errors', !page.errors.length, page.errors);
} catch (e) {
  failed++;
  console.log('FAIL  ', e);
  if (shots) await page.shot('/tmp/verify-phone-failure.png').catch(() => {});
} finally {
  await close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
