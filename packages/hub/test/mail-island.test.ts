/**
 * The mail editor's HTML on the hub (island.ts): style sheets written into style attributes, islands for forwards and
 * quotes, the HTML that goes (pictures linked, embedded or left out) and the text part made from the editor's Markdown.
 */
import { describe, expect, test } from 'bun:test';
import { demoStoreNewsletter } from '../src/mail/demo-html.ts';
import { inlineCss, islandOf, islandsOf, outgoingHtml, outgoingText, specificity, type OutgoingCtx } from '../src/mail/island.ts';
import { sanitizeMail } from '../src/mail/sanitize.ts';
import type { ComposeOriginal } from '../src/mail/compose.ts';

const o: ComposeOriginal = {
  from: { name: 'Northbound Outfitters', email: 'deals@store.example' },
  to: [{ name: null, email: 'me@dither.example' }],
  cc: [],
  replyTo: [],
  subject: 'The winter sale',
  date: Date.UTC(2026, 10, 3, 18, 42),
  text: 'Our biggest sale.\nMembers save more.',
};

describe('inlineCss', () => {
  test('specificity orders ids over classes over types', () => {
    expect(specificity('#a')).toBeGreaterThan(specificity('.a.b.c'));
    expect(specificity('.a')).toBeGreaterThan(specificity('div p span'));
    expect(specificity('a:first-child')).toBe(specificity('a.b'));
  });

  test('rules land in style attributes in cascade order; own style wins; !important wins over own', () => {
    const html = '<style>p{color:red;margin:0} .x{color:blue} #y{color:green} .imp{font-weight:bold!important}</style><div class="r"><p class="x" id="y" style="color:black">a</p><p class="x imp" style="font-weight:normal">b</p></div>';
    const out = inlineCss(html, 'r');
    expect(out).not.toContain('<style>');
    expect(out).toContain('style="color:red;margin:0;color:blue;color:green;color:black"');
    expect(out).toContain('style="color:red;margin:0;color:blue;font-weight:normal;font-weight:bold !important"');
  });

  test('body rules go to the root; @media and hover stay in a sheet scoped to the root', () => {
    const html = '<style>body{background:#eee} body .a{color:red} a:hover{color:blue} @media (max-width:600px){.a{width:100%}}</style><div class="root"><span class="a">x</span><a href="#">y</a></div>';
    const out = inlineCss(html, 'root');
    expect(out).toContain('<div class="root" style="background:#eee">');
    expect(out).toContain('<span class="a" style="color:red">');
    expect(out).toMatch(/<style>[^<]*\.root a:hover\{color:blue\}/);
    expect(out).toMatch(/@media \(max-width:600px\)\{\.root \.a\{width:100%\}\}/);
  });

  test('a big newsletter keeps its look: classes become styles, pictures keep their addresses, trackers go', () => {
    const san = sanitizeMail(demoStoreNewsletter(), {
      images: 'block',
      keepSource: true,
      decide: (url, shaped) => (shaped || /track|\/o\//.test(url) ? { action: 'drop', class: 'tracker', why: 't' } : { action: /hi\//.test(url) ? 'hold' : 'load', class: /hi\//.test(url) ? 'personal' : 'shared', why: '' }),
      proxy: (u) => `/api/mail/img/T${encodeURIComponent(u)}`,
    });
    const isl = islandOf('forward', o, san, 'abc', 'UTC');
    expect(isl.html).toContain('Forwarded message');
    expect(isl.html).toContain('class="dc-isl-abc"');
    // .card's border is on each card now.
    expect(isl.html).toMatch(/class="card" style="[^"]*border:1px solid #d8e1e8/);
    expect(isl.html).not.toContain('track/open.php');
    expect(isl.html).toContain('data-dc-src="https://cdn.store.example/products/');
    expect(isl.html).toMatch(/data-dc-src="https:\/\/img\.store\.example\/hi\/[^"]+"[^>]*data-dc-held="personal"|data-dc-held="personal"[^>]*data-dc-src/);
  });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ctx = (over: Partial<OutgoingCtx> = {}): OutgoingCtx => ({
  pictures: 'link',
  inlineParts: true,
  resolve: (src) => (src.startsWith('/api/mail/img/T') ? { url: decodeURIComponent(src.slice('/api/mail/img/T'.length)) } : null),
  fetchPicture: async () => ({ bytes: PNG, mime: 'image/png' }),
  cidPart: async () => null,
  id: 'mob_test1234',
  ...over,
});
const draftHtml =
  `<p>Hi <b>there</b></p><p><img src="data:image/png;base64,${PNG.toString('base64')}" alt="shot"></p>` +
  '<div data-dc-island="forward" data-dc-ref="r1" data-dc-label="x"><div class="dc-isl-r1 dc-quote"><img data-dc-src="https://cdn.store.example/a.png" src="/api/mail/img/Thttps%3A%2F%2Fcdn.store.example%2Fa.png"><img data-dc-src="https://img.store.example/hi/abc/me.png" src="data:image/svg+xml;base64,AAAA" data-dc-held="personal"></div></div>' +
  '<script>alert(1)</script><p onclick="x()">end</p>';

describe('outgoingHtml', () => {
  test('link: pasted pictures become parts, web pictures keep their own addresses, the hub never shows', async () => {
    const r = await outgoingHtml(draftHtml, ctx());
    expect(r.inline).toHaveLength(1);
    expect(r.html).toContain(`src="cid:${r.inline[0].contentId}"`);
    expect(r.html).toContain('src="https://cdn.store.example/a.png"');
    expect(r.html).toContain('src="https://img.store.example/hi/abc/me.png"');
    expect(r.html).not.toContain('/api/mail/');
    expect(r.html).not.toContain('data-dc-');
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('onclick');
    expect(r.html).not.toContain('dc-quote');
    expect([r.linked, r.embedded, r.dropped]).toEqual([2, 1, 0]);
  });

  test('embed: every picture goes inside the mail', async () => {
    const r = await outgoingHtml(draftHtml, ctx({ pictures: 'embed' }));
    expect(r.inline).toHaveLength(3);
    expect(r.html).not.toMatch(/src="https?:/);
    expect(r.embedded).toBe(3);
  });

  test('embed without inline parts: data: URLs', async () => {
    const r = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', inlineParts: false }));
    expect(r.inline).toHaveLength(0);
    expect(r.html.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
  });

  test('drop: web pictures left out, pasted ones kept; a picture that cannot be fetched stays linked', async () => {
    const d = await outgoingHtml(draftHtml, ctx({ pictures: 'drop' }));
    expect(d.dropped).toBe(2);
    expect(d.inline).toHaveLength(1);
    const f = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', fetchPicture: async () => null }));
    expect(f.failed).toBe(2);
    expect(f.html).toContain('src="https://cdn.store.example/a.png"');
  });
});

describe('outgoingText', () => {
  test('stand-ins become the forwarded block and picture names', () => {
    const md = 'Hi **there**\n\n![shot](dc-picture:p1)\n\n[[island:r1]]\n';
    const t = outgoingText(md, draftHtml, o, 'UTC');
    expect(t).toContain('Hi **there**');
    expect(t).toContain('[picture: shot]');
    expect(t).toContain('---------- Forwarded message ---------');
    expect(t).toContain('Our biggest sale.');
    expect(islandsOf(draftHtml).get('r1')?.kind).toBe('forward');
  });
});
