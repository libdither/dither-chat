/**
 * QR codes (docs/add.md, "QR codes"), end to end against a demo hub in headless Chromium: My code in the New box shows
 * each demo account's code, and a screenshot of each decodes (jsQR, in the page) back to the link under it, in a dark
 * and a light theme; a phone number's code stays hidden until "Show my number's code" is tapped; Scan with a picture
 * of a demo Discord invite fills the box and lands on its preview, joining nothing; a pasted picture of a code that is
 * not a link shows its text and the plain line; a place's invite link has Show QR beside it, decoding to the link;
 * and My code on a phone fits.
 *
 *   bun scripts/verify-qr.ts http://127.0.0.1:8850 [/tmp/shots]
 * Point it at a fresh demo hub (--demo) with its own data dir.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qrSvg } from '../packages/web/src/qr.ts';
import { launch } from './browser.ts';

const hub = process.argv[2] ?? 'http://127.0.0.1:8850';
const shots = process.argv[3];
if (shots) mkdirSync(shots, { recursive: true });

const boot = (await fetch(`${hub}/api/bootstrap`).then((r) => r.json())) as any;
if (!boot.accounts.length || !boot.accounts.every((a: any) => a.demo)) throw new Error('not a demo hub');
const climb = boot.conversations.find((c: any) => c.network === 'signal' && c.name === 'Climbing crew 🧗')?.id;
if (!climb) throw new Error('the demo world lacks the Signal climbing group');

/** What each demo account's code must hold, built here from the bootstrap independently of the page's code. */
const expected = (a: any): { url: string; number: boolean } | null => {
  const me = boot.identities.find((i: any) => i.id === a.selfIdentityId);
  if (!me) return null;
  const digits = (s: string) => s.replace(/\D/g, '');
  switch (a.network) {
    case 'discord':
      return { url: `https://discord.com/users/${me.nativeId}`, number: false };
    case 'matrix':
      return { url: `https://matrix.to/#/${me.nativeId}`, number: false };
    case 'telegram':
      return { url: `https://t.me/${me.handle.replace(/^@/, '')}`, number: false };
    case 'whatsapp':
      return { url: `https://wa.me/${digits(me.nativeId.split('@')[0])}`, number: true };
    case 'signal':
      return { url: `https://signal.me/#p/+${digits(me.handle)}`, number: true };
  }
  return null;
};

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};

const jsqrSource = await Bun.file(resolve(import.meta.dir, '../packages/web/node_modules/jsqr/dist/jsQR.js')).text();

const { page: p, close } = await launch();
const click = async (sel: string) => {
  const r = await p.eval<{ x: number; y: number } | null>(
    `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.getBoundingClientRect().width > 0); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
};
const text = (sel: string) => p.eval<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.innerText).join(' | ')`);
const has = (sel: string) => p.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const shot = async (name: string) => shots && (await p.shot(join(shots, `${name}.png`)));
const box = '.new-message input.input';
const openBox = async () => {
  if (await has('.new-message')) await click('.new-message .modal-head [aria-label="Close"]');
  await p.until(`!document.querySelector('.new-message')`, 3000);
  await click('.side-new');
  await p.until(`!!document.querySelector(${JSON.stringify(box)})`, 3000);
};
/** A fresh page load, even to the same address (a theme is read at start). */
const load = async (path: string) => {
  await p.goto('about:blank');
  await p.goto(`${hub}/${path}`);
  await p.until(`!!document.querySelector('.side-new, .profile-page')`, 20000);
  await p.eval(jsqrSource);
};

/** Screenshot what is on screen where the code is, and read it with jsQR in the page: what a phone's camera would get. */
const decodeOnScreen = async (sel: string): Promise<{ text: string | null; bg: string; w: number }> => {
  const r = await p.eval<{ x: number; y: number; w: number; h: number; bg: string } | null>(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, bg: getComputedStyle(e).backgroundColor }; })()`,
  );
  if (!r) return { text: null, bg: '', w: 0 };
  await Bun.sleep(100);
  const { data } = await p.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
  const text = await p.eval<string | null>(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${data}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    return jsQR(d.data, c.width, c.height)?.data ?? null;
  })()`);
  return { text, bg: r.bg, w: r.w };
};

/** A PNG of a code for `content`, made in the page, as a File: what a photo or screenshot of one would be. */
const pictureOf = (content: string) => `(async () => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(qrSvg(content).replace('<svg ', '<svg width="360" height="360" '))});
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 360;
  c.getContext('2d').drawImage(img, 0, 0, 360, 360);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
  return new File([blob], 'code.png', { type: 'image/png' });
})()`;

const myCodes = async (theme: string) => {
  for (const a of boot.accounts) {
    const want = expected(a);
    if (!want) continue;
    if (await has('.qr-accounts')) await click(`.qr-accounts [data-account="${a.id}"]`);
    await p.until(`document.querySelector('.qr-mine')?.dataset.account === ${JSON.stringify(a.id)}`, 3000);
    if (want.number) {
      const me = boot.identities.find((i: any) => i.id === a.selfIdentityId);
      const last = me.nativeId.includes('@') ? me.nativeId.split('@')[0].slice(-7) : me.handle.replace(/\D/g, '').slice(-7);
      const numberRe = new RegExp(last.split('').join('[\\s().-]?'));
      const before = await text('.qr-mine');
      check(!(await has('.qr-mine .qr-code')) && !(await has('.qr-mine .qr-link')) && !numberRe.test(before) && (await has('.qr-reveal')), `${theme}: ${a.network}: the number's code is hidden until tapped, with a warning`, before.slice(0, 160));
      await click('.qr-reveal');
      await p.until(`!!document.querySelector('.qr-mine .qr-code')`, 3000);
    }
    const link = await text('.qr-mine .qr-link');
    const got = await decodeOnScreen('.qr-mine .qr-code');
    check(got.text === want.url && link === want.url && got.bg === 'rgb(255, 255, 255)', `${theme}: ${a.network} (${a.label}): the code decodes to its link, shown under it, on white`, { got: got.text, link, bg: got.bg });
  }
};

try {
  await p.size(1280, 860);
  await load('#/inbox');

  // 1. My code, in the default dark theme, then a light one.
  await openBox();
  check(await has('.new-message .qr-scan-btn') && (await has('.new-message .qr-mine-btn')), 'the New box has Scan a code and My code');
  await click('.qr-mine-btn');
  await p.until(`!!document.querySelector('.qr-mine')`, 3000);
  check((await text('.new-message h2')) === 'My code', 'My code opens in the box');
  const chips = await p.eval<string[]>(`[...document.querySelectorAll('.qr-accounts [data-account]')].map((b) => b.dataset.account)`);
  check(chips.length === boot.accounts.length, 'one chip per account', chips);
  check(await has('.qr-mine .qr-copy'), 'a code has Copy');
  await shot('qr-01-mine');
  await myCodes('dark');
  // Signal says a username code needs the adapter.
  await click(`.qr-accounts [data-account="${boot.accounts.find((a: any) => a.network === 'signal').id}"]`);
  check((await text('.qr-mine .qr-note')).includes("needs the account's adapter"), 'Signal says a username code needs the adapter', await text('.qr-mine .qr-note'));
  // Leaving and coming back hides the number again.
  await click('.qr-back');
  await click('.qr-mine-btn');
  await click(`.qr-accounts [data-account="${boot.accounts.find((a: any) => a.network === 'whatsapp').id}"]`);
  check((await has('.qr-reveal')) && !(await has('.qr-mine .qr-code')), 'the number is hidden again when My code opens again');
  await shot('qr-02-hidden-number');

  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-light' }))`);
  await load('#/inbox');
  check((await p.eval(`document.documentElement.dataset.theme`)) === 'light', 'a light theme is on');
  await openBox();
  await click('.qr-mine-btn');
  await p.until(`!!document.querySelector('.qr-mine')`, 3000);
  await myCodes('light');
  await shot('qr-03-mine-light');
  await p.eval(`localStorage.setItem('dither-chat:prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('dither-chat:prefs') || '{}'), theme: 'dither-dark' }))`);
  await load('#/inbox');

  // 2. Scan: a picture of a demo Discord invite, chosen as a file, fills the box and lands on its preview.
  await openBox();
  await click('.qr-scan-btn');
  await p.until(`!!document.querySelector('.qr-scan')`, 3000);
  check((await text('.new-message h2')) === 'Scan a code', 'Scan opens in the box');
  // Headless Chromium has no camera: it says so, and a picture still works.
  await p.until(`!['off', 'starting'].includes(document.querySelector('.qr-camera')?.dataset.camera)`, 8000);
  const camera = await p.eval<string>(`document.querySelector('.qr-camera').dataset.camera`);
  check(camera !== 'on' && (await text('.qr-camera-problem')).includes('picture of the code'), 'no camera: it says so, and offers a picture', { camera, line: await text('.qr-camera-problem') });
  await shot('qr-04-scan');
  await p.eval(`(async () => { const f = await ${pictureOf('https://discord.gg/pixelart')}; const dt = new DataTransfer(); dt.items.add(f); const i = document.querySelector('.qr-picture input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.until(`!!document.querySelector('.add-card-name, .add-error') && !document.querySelector('.add-loading')`, 10000);
  const card = await text('.add-card');
  check(card.includes('Pixel Art Club') && (await has('.add-actions [data-action="join"]')), 'a scanned Discord invite lands on its preview, with Join', card);
  check(!(await fetch(`${hub}/api/bootstrap`).then((r) => r.json() as Promise<any>)).spaces.some((s: any) => s.name === 'Pixel Art Club'), 'and nothing was joined');
  await shot('qr-05-scanned');
  await click('.add-actions .btn.ghost:last-child');
  check((await p.eval(`document.querySelector(${JSON.stringify(box)})?.value`)) === 'https://discord.gg/pixelart', 'Back shows the box filled with the scanned link');

  // 3. A pasted picture of a code that is not a link: its text and the plain line, nothing filled.
  await click('.qr-scan-btn');
  await p.until(`!!document.querySelector('.qr-scan')`, 3000);
  const wifi = 'WIFI:S:DemoCafe;T:WPA;P:example;;';
  await p.eval(`(async () => { const f = await ${pictureOf(wifi)}; const dt = new DataTransfer(); dt.items.add(f); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
  await p.until(`!!document.querySelector('.qr-other')`, 8000);
  check((await text('.qr-other-line')).includes("This code isn't an invite or a profile link") && (await text('.qr-other-text')) === wifi, 'a code that is not a link: its text and the plain line', await text('.qr-other'));
  await shot('qr-06-other');
  await click('.qr-again');
  check(await has('.qr-camera'), 'Scan another goes back to the scanner');

  // 4. A place's invite link: Show QR beside it draws the same link.
  await load(`#/about/c/${climb}`);
  await p.until(`!!document.querySelector('.about-invite code')`, 15000);
  check(await has('.about-invite-link .about-qr'), 'Show QR sits beside the invite link');
  await click('.about-invite .about-qr');
  await p.until(`!!document.querySelector('.about-invite .qr-code')`, 3000);
  const inv = await text('.about-invite code');
  const placeCode = await decodeOnScreen('.about-invite .qr-code');
  check(inv.startsWith('https://signal.group/') && placeCode.text === inv, "the place's code decodes to its invite link", { inv, got: placeCode.text });
  await shot('qr-07-place');

  // 5. On a phone, once: My code fits.
  await p.size(390, 844, true);
  await load('#/inbox');
  await openBox();
  await Bun.sleep(500); // the sheet slides up
  await click('.qr-mine-btn');
  await p.until(`!!document.querySelector('.qr-mine .qr-code')`, 3000);
  const fit = await p.eval<{ right: number; code: number; scroll: number }>(
    `(() => { const m = document.querySelector('.new-message').getBoundingClientRect(); const c = document.querySelector('.qr-mine .qr-code').getBoundingClientRect(); return { right: m.right, code: c.right <= 390 && c.left >= 0 ? c.width : -1, scroll: document.documentElement.scrollWidth }; })()`,
  );
  const phone = await decodeOnScreen('.qr-mine .qr-code');
  check(fit.right <= 391 && fit.scroll <= 391 && fit.code >= 200 && phone.text?.startsWith('https://'), 'on a phone the code fits the sheet and decodes', { ...fit, got: phone.text });
  await shot('qr-08-phone');

  check(!p.errors.length, 'no page errors', p.errors);
} finally {
  await close();
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log('all passed');
