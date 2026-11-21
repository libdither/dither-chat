/**
 * The mail editor's HTML on the hub (island.ts): style sheets written into style attributes, islands for forwards and
 * quotes, the HTML that goes (pictures linked, embedded or left out) and the text part made from the editor's Markdown.
 */
import { describe, expect, test } from 'bun:test';
import { demoStoreNewsletter } from '../src/mail/demo-html.ts';
import { inlineCss, islandOf, islandPrint, islandsOf, islandText, outgoingHtml, outgoingText, plainText, scriptUrl, specificity, type OutgoingCtx } from '../src/mail/island.ts';
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

  test('a sheet hidden in <!-- --> keeps its first rule, and nothing of the marks is left', () => {
    const html = '<style><!--\np{color:red} .x{margin:0}\n--></style><div class="r"><p class="x">a</p></div>';
    const out = inlineCss(html, 'r');
    expect(out).toContain('<p class="x" style="color:red;margin:0">');
    expect(out).not.toContain('\\3c');
    expect(out).not.toContain('<style>');
  });

  test('a sheet in <![CDATA[ ]]> keeps its first rule, and nothing of the marks is left', () => {
    const out = inlineCss('<style><![CDATA[\np{color:red} .x{margin:0}\n]]></style><div class="r"><p class="x">a</p></div>', 'r');
    expect(out).toContain('<p class="x" style="color:red;margin:0">');
    expect(out).not.toMatch(/CDATA|\]\]|\\3c/);
  });

  test('an element’s own !important beats the sheet’s !important; the sheet’s beats its own plain style', () => {
    const html = '<style>p{color:red!important;margin:0!important}</style><div class="r"><p style="color:black !important;margin:4px">a</p></div>';
    const out = inlineCss(html, 'r');
    const style = /<p style="([^"]*)"/.exec(out)![1];
    // Last of each property wins: color is its own (important), margin the sheet's (important over a plain one).
    const last = (prop: string) => style.split(';').filter((d) => d.trim().startsWith(`${prop}:`)).pop();
    expect(last('color')).toBe('color:black !important');
    expect(last('margin')).toBe('margin:0 !important');
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
  cachedPicture: async () => null,
  canTell: () => false,
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
    const r = await outgoingHtml(draftHtml, ctx({ linkCanTell: true }));
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

  test('link: the ones that can tell are left out unless asked for, and counted', async () => {
    const r = await outgoingHtml(draftHtml, ctx());
    expect(r.html).toContain('src="https://cdn.store.example/a.png"');
    expect(r.html).not.toContain('img.store.example');
    expect([r.linked, r.embedded, r.dropped]).toEqual([1, 1, 1]);
    expect(r.leftOut).toEqual({ failed: 0, canTell: 1 });
    // One the classifier says can tell, though the island did not hold it, goes the same way.
    const c = await outgoingHtml(draftHtml, ctx({ canTell: (u) => u.includes('cdn.store') }));
    expect(c.html).not.toContain('cdn.store.example');
    expect(c.leftOut.canTell).toBe(2);
  });

  test('an address without its scheme is the web’s: linked over https, fetched in with Embed', async () => {
    const html = '<p>Hi <img src="//cdn.store.example/a.png"></p>';
    const r = await outgoingHtml(html, ctx());
    expect(r.html).toContain('src="https://cdn.store.example/a.png"');
    expect(r.linked).toBe(1);
    const fetched: string[] = [];
    const e = await outgoingHtml(html, ctx({ pictures: 'embed', fetchPicture: async (u) => (fetched.push(u), { bytes: PNG, mime: 'image/png' }) }));
    expect(fetched).toEqual(['https://cdn.store.example/a.png']);
    expect(e.embedded).toBe(1);
  });

  test('embed: pictures go inside the mail; one that can tell only when the hub has it, else it is left out', async () => {
    const fetched: string[] = [];
    const r = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', fetchPicture: async (u) => (fetched.push(u), { bytes: PNG, mime: 'image/png' }) }));
    expect(r.inline).toHaveLength(2);
    expect(r.html).not.toMatch(/src="https?:/);
    expect(r.html).not.toContain('img.store.example');
    expect(r.embedded).toBe(2);
    expect(r.leftOut).toEqual({ failed: 0, canTell: 1 });
    // The held one (data-dc-held="personal") was never fetched.
    expect(fetched).toEqual(['https://cdn.store.example/a.png']);
    // The hub has it already: then it goes inside too, still without a request.
    const c = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', cachedPicture: async (u) => (u.includes('/hi/') ? { bytes: PNG, mime: 'image/png' } : null) }));
    expect([c.embedded, c.leftOut.canTell]).toEqual([3, 0]);
    // ctx.canTell says so of an address too, held or not.
    const t = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', canTell: (u) => u.includes('cdn.store') }));
    expect(t.leftOut.canTell).toBe(2);
  });

  test('embed without inline parts: data: URLs', async () => {
    const r = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', inlineParts: false, cachedPicture: async () => ({ bytes: PNG, mime: 'image/png' }) }));
    expect(r.inline).toHaveLength(0);
    expect(r.html.match(/src="data:image\/png;base64,/g)).toHaveLength(3);
  });

  test('drop: web pictures left out, pasted ones kept; with embed, a picture that cannot be fetched is left out, never linked', async () => {
    const d = await outgoingHtml(draftHtml, ctx({ pictures: 'drop' }));
    expect(d.dropped).toBe(2);
    expect(d.inline).toHaveLength(1);
    const f = await outgoingHtml(draftHtml, ctx({ pictures: 'embed', fetchPicture: async () => null }));
    expect(f.leftOut).toEqual({ failed: 1, canTell: 1 });
    expect(f.html).not.toContain('cdn.store.example');
    expect(f.html).not.toMatch(/src="https?:/);
  });
});

const BG = (u: string) => `/api/mail/img/T${encodeURIComponent(u)}`;
const bgHtml =
  '<div data-dc-island="forward" data-dc-ref="r2"><div class="dc-isl-r2">' +
  `<table background="${BG('https://cdn.store.example/bg.png')}"><tr><td style="background:url('${BG('https://cdn.store.example/cell.png')}') no-repeat;color:red">x</td>` +
  '<td style="background-image:url(https://cdn.store.example/raw.png)">y</td><td background="/api/mail/img/bogus">z</td></tr></table>' +
  '<style>.dc-isl-r2 .a{background:url("https://cdn.store.example/sheet.png")}</style></div></div>';

describe('outgoingHtml: backgrounds', () => {
  test('embed: every background goes inside the mail, as pictures do; nothing is fetched on their end', async () => {
    const asked: string[] = [];
    const r = await outgoingHtml(bgHtml, ctx({ pictures: 'embed', fetchPicture: async (u) => (asked.push(u), { bytes: PNG, mime: 'image/png' }) }));
    expect(asked.sort()).toEqual(['https://cdn.store.example/bg.png', 'https://cdn.store.example/cell.png', 'https://cdn.store.example/raw.png', 'https://cdn.store.example/sheet.png']);
    expect(r.inline).toHaveLength(4);
    expect(r.embedded).toBe(4);
    expect(r.insideBytes).toBe(4 * PNG.length);
    expect(r.html).not.toMatch(/https?:/);
    expect(r.html).not.toContain('/api/mail/');
    expect(r.html).toMatch(/<table background="cid:dc\d\.[^"]+">/);
    expect(r.html).toMatch(/background:url\(&quot;cid:[^&]+&quot;\) no-repeat;color:red/);
    expect(r.html).toMatch(/\.dc-isl-r2 \.a\{background:url\("cid:/);
    // An address of this hub that stands for nothing goes.
    expect(r.html).toContain('<td>z</td>');
  });

  test('embed without inline parts: data: URLs; a background that cannot be fetched is left out', async () => {
    const r = await outgoingHtml(bgHtml, ctx({ pictures: 'embed', inlineParts: false, fetchPicture: async (u) => (u.endsWith('raw.png') ? null : { bytes: PNG, mime: 'image/png' }) }));
    expect(r.inline).toHaveLength(0);
    expect(r.html).toContain('background="data:image/png;base64,');
    expect(r.html).toContain('background-image:none');
    expect(r.html).not.toContain('raw.png');
    expect(r.leftOut.failed).toBe(1);
    expect(r.html).not.toContain('/api/mail/');
  });

  test('link: this hub’s addresses become the addresses they stand for', async () => {
    const r = await outgoingHtml(bgHtml, ctx());
    expect(r.html).toContain('<table background="https://cdn.store.example/bg.png">');
    expect(r.html).toContain('url(&quot;https://cdn.store.example/cell.png&quot;)');
    expect(r.html).toContain('url(&quot;https://cdn.store.example/raw.png&quot;)');
    expect(r.html).toContain('url("https://cdn.store.example/sheet.png")');
    expect(r.html).not.toContain('/api/mail/');
    expect(r.linked).toBe(4);
  });

  test('drop: backgrounds from the web are left out', async () => {
    const r = await outgoingHtml(bgHtml, ctx({ pictures: 'drop' }));
    expect(r.html).not.toContain('cdn.store.example');
    expect(r.html).not.toContain('/api/mail/');
    expect(r.html).not.toContain('background=');
    expect(r.html).toContain('background:none no-repeat;color:red');
    expect(r.dropped).toBe(4);
  });

  test('a picture’s address with &amp; in it is fetched and linked as the address it is', async () => {
    const html = '<p><img data-dc-src="https://cdn.store.example/p.png?w=1&amp;h=2" src="/x"></p>';
    const asked: string[] = [];
    await outgoingHtml(html, ctx({ pictures: 'embed', fetchPicture: async (u) => (asked.push(u), { bytes: PNG, mime: 'image/png' }) }));
    expect(asked).toEqual(['https://cdn.store.example/p.png?w=1&h=2']);
    expect((await outgoingHtml(html, ctx())).html).toContain('src="https://cdn.store.example/p.png?w=1&amp;h=2"');
  });
});

describe('outgoingHtml: image-set, media, SVG and other ways to fetch', () => {
  const media =
    `<div style="background-image:image-set('${BG('https://cdn.store.example/set1.png')}' 1x, url(https://cdn.store.example/set2.png) 2x)">s</div>` +
    '<div style="background:-webkit-image-set(url(https://cdn.store.example/wk.png) 1x)">w</div>' +
    '<video src="https://media.store.example/v.mp4" poster="https://cdn.store.example/poster.png"><source src="https://media.store.example/v.webm"><track src="/api/mail/x.vtt">Your app shows no video</video>' +
    '<audio src="https://media.store.example/a.mp3"></audio>' +
    `<svg width="10" height="10"><image href="${BG('https://cdn.store.example/svg.png')}" width="10" height="10"></image><image xlink:href="https://cdn.store.example/svg2.png"></image></svg>` +
    '<input type="image" src="https://cdn.store.example/in.png"><link rel="icon" href="https://cdn.store.example/icon.png">';

  test('embed: image-set’s first choice, SVG images inside the mail; video and audio gone, their fallback kept', async () => {
    const asked: string[] = [];
    const r = await outgoingHtml(media, ctx({ pictures: 'embed', fetchPicture: async (u) => (asked.push(u), { bytes: PNG, mime: 'image/png' }) }));
    expect(asked.sort()).toEqual(['https://cdn.store.example/set1.png', 'https://cdn.store.example/svg.png', 'https://cdn.store.example/svg2.png', 'https://cdn.store.example/wk.png']);
    expect(r.html).not.toMatch(/https?:|\/api\/mail\/|image-set|<video|<audio|<source|<track|<input|<link/);
    expect(r.html).toContain('Your app shows no video');
    expect(r.html.match(/<image href="cid:/g)).toHaveLength(2);
    expect(r.embedded).toBe(4);
  });

  test('drop: nothing that fetches is left', async () => {
    const r = await outgoingHtml(media, ctx({ pictures: 'drop' }));
    expect(r.html).not.toMatch(/https?:|\/api\/mail\/|<video|<audio|<image|<input|<link/);
    expect(r.html).toContain('background-image:none');
  });

  test('link: each keeps its own address; this hub’s never leave', async () => {
    const r = await outgoingHtml(media, ctx());
    expect(r.html).toContain('background-image:url(&quot;https://cdn.store.example/set1.png&quot;)');
    expect(r.html).toContain('<video src="https://media.store.example/v.mp4" poster="https://cdn.store.example/poster.png">');
    expect(r.html).toContain('<source src="https://media.store.example/v.webm">');
    expect(r.html).toContain('<audio src="https://media.store.example/a.mp3">');
    expect(r.html).toContain('<image href="https://cdn.store.example/svg.png"');
    expect(r.html).not.toContain('/api/mail/');
    expect(r.html).not.toContain('<track');
    expect(r.html).not.toMatch(/<input|<link/);
  });
});

describe('outgoingHtml: script addresses', () => {
  test('javascript: however it is written goes; ordinary links stay', async () => {
    const bad = ['java&#9;script:alert(1)', '&#106;avascript:alert(1)', ' javascript:alert(1)', 'jav&Tab;ascript:alert(1)', 'java&#x0A;script:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)', '\u0001javascript:alert(1)'];
    for (const b of bad) expect(scriptUrl(b)).toBe(true);
    const html = bad.map((b, i) => `<a href="${b}">l${i}</a>`).join('') + '<a href="https://x.example/?a=1&amp;b=2">ok</a><a href="mailto:a@b.example">m</a>';
    const r = await outgoingHtml(html, ctx());
    expect(r.html).not.toMatch(/script:/i);
    expect(r.html.match(/href=/g)).toHaveLength(2);
    expect(r.html).toContain('href="https://x.example/?a=1&amp;b=2"');
    expect(scriptUrl('https://x.example/javascript:')).toBe(false);
  });
});

const wrap = (isl: { kind: string; html: string }, ref = 'r1') => `<p>Hi</p><div data-dc-island="${isl.kind}" data-dc-ref="${ref}" data-dc-label="x">${isl.html}</div>`;

describe('the text part is plain text', () => {
  test('tags gone, their text kept; line breaks for <br> and blocks; entities decoded; Markdown marks stay', () => {
    const md =
      'Hi **there**\n\n<p style="text-align: center">centred &amp; <span style="color:#c00">red</span></p>\n\n- a\n- b\n\n> quoted\n\n' +
      '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>\n\nline<br>next <a href="https://x.example/a">link</a> <u>under</u> <img src="x" alt="cat">\n\n' +
      'Sam <sam@lee.example> or <https://x.example>.\n\n```html\n<p>code</p>\n```\n\nand `<b>inline</b>` code';
    const t = plainText(md);
    expect(t).toBe(
      'Hi **there**\n\ncentred & red\n\n- a\n- b\n\n> quoted\n\na | b\nc | d\n\nline\nnext [link](https://x.example/a) under [picture: cat]\n\n' +
        'Sam <sam@lee.example> or <https://x.example>.\n\n```html\n<p>code</p>\n```\n\nand `<b>inline</b>` code',
    );
  });

  test('outgoingText: a centred paragraph next to a forward goes as its words; the forward’s headers keep their <address>', () => {
    const isl = islandOf('forward', o, null, 'r1', 'UTC');
    const t = outgoingText('<p style="text-align: center">centred</p>\n\n[[island:r1]]', wrap(isl), o, 'UTC');
    expect(t).toStartWith('centred\n\n---------- Forwarded message ---------');
    expect(t).toContain('From: Northbound Outfitters <deals@store.example>');
    expect(t).not.toContain('<p');
  });
});

describe('outgoingText', () => {
  test('stand-ins become the forwarded block and picture names', () => {
    const isl = islandOf('forward', o, null, 'r1', 'UTC');
    const md = 'Hi **there**\n\n![shot](dc-picture:p1)\n\n[[island:r1]]\n';
    const html = `<p>Hi <b>there</b></p><p><img src="data:image/png;base64,${PNG.toString('base64')}" alt="shot"></p>${wrap(isl).replace('<p>Hi</p>', '')}`;
    const t = outgoingText(md, html, o, 'UTC');
    expect(t).toContain('Hi **there**');
    expect(t).toContain('[picture: shot]');
    expect(t).toContain('---------- Forwarded message ---------');
    expect(t).toContain('Our biggest sale.');
    expect(islandsOf(html).get('r1')?.kind).toBe('forward');
  });

  test('textBytes is what the island adds to the text part, for a forward of a big HTML mail too', () => {
    const san = sanitizeMail(demoStoreNewsletter(), { images: 'block', keepSource: true, decide: () => ({ action: 'load', class: 'shared', why: '' }), proxy: (u) => `/api/mail/img/T${encodeURIComponent(u)}` });
    const short = { ...o, text: 'Short text.' };
    for (const [isl, orig] of [
      [islandOf('forward', short, san, 'r1', 'UTC'), short],
      [islandOf('quote', o, null, 'r1', 'UTC'), o],
    ] as const) {
      const t = outgoingText('[[island:r1]]', wrap(isl), orig, 'UTC');
      expect(Buffer.byteLength(t)).toBe(isl.textBytes!);
      expect(isl.textBytes).toBe(Buffer.byteLength(islandText(isl, orig, 'UTC')));
    }
    // The forward's text part is the original's text, far smaller than the island's HTML's text.
    const fwd = islandOf('forward', short, san, 'r1', 'UTC');
    expect(fwd.textBytes!).toBeLessThan(1000);
    expect(outgoingText('[[island:r1]]', wrap(fwd), short, 'UTC')).toContain('Short text.');
  });

  test('an island as a browser writes it back (new lines, entities) is still the one the hub made', () => {
    const isl = islandOf('forward', { ...o, text: 'Fish & chips, “today”.' }, null, 'r1', 'UTC');
    const html = isl.html.replace(/></g, '>\n<').replace(/“/g, '&ldquo;').replace(/”/g, '&rdquo;');
    expect(islandPrint(html)).toBe(islandPrint(isl.html));
    const t = outgoingText('[[island:r1]]', wrap({ kind: 'forward', html }), { ...o, text: 'Fish & chips, “today”.' }, 'UTC');
    expect(t).toContain('---------- Forwarded message ---------');
  });

  test('an island edited in the HTML view: the text part is made from its HTML, not the original', () => {
    const fwd = islandOf('forward', o, null, 'r1', 'UTC');
    const edited = fwd.html.replace('Our biggest sale.', 'A smaller sale, edited.');
    const t = outgoingText('[[island:r1]]', wrap({ kind: 'forward', html: edited }), o, 'UTC');
    expect(t).toContain('A smaller sale, edited.');
    expect(t).not.toContain('Our biggest sale.');
    expect(t).toContain('Forwarded message');
    // A quote edited: its attribution, then its words quoted.
    const q = islandOf('quote', o, null, 'r1', 'UTC');
    const qt = outgoingText('[[island:r1]]', wrap({ kind: 'quote', html: q.html.replace('Members save more.', 'Members save less.') }), o, 'UTC');
    expect(qt).toMatch(/wrote:\n> Our biggest sale\.\n> Members save less\./);
    // One without the hub's fingerprint (pasted in) counts as edited.
    const bare = outgoingText('[[island:r1]]', wrap({ kind: 'forward', html: '<p>Pasted words</p>' }), o, 'UTC');
    expect(bare).toBe('Pasted words');
  });

  test('a forward of a mail with no text part: the text is the island’s own', () => {
    const htmlOnly = { ...o, text: null };
    const isl = islandOf('forward', htmlOnly, { html: '<p>Only <b>HTML</b> here.</p>', body: {} }, 'r1', 'UTC');
    const t = outgoingText('[[island:r1]]', wrap(isl), htmlOnly, 'UTC');
    expect(t).toContain('Forwarded message');
    expect(t).toContain('Only HTML here.');
  });
});
