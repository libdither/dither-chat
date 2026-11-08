/**
 * An email's HTML made safe to show (docs/mail-design.md §7), with Bun's HTMLRewriter and an allowlist.
 *
 * What goes, with everything inside it: script, style sheets from elsewhere, frames, objects, forms and their
 * controls, meta, base, svg, math, templates, and every element whose content a browser reads as raw text (textarea,
 * title, xmp, noscript, …), so no text this pass did not see as text can turn into markup. Comments and the doctype go
 * too. Other unknown elements lose their tag and keep their content.
 *
 * Every attribute an element keeps is written again from its decoded value (entities included), so the browser reads
 * exactly the value checked here: on* and anything not on the list go; href is http(s), mailto or #; src and
 * background are rewritten (a proxy token or a placeholder; cid: to the message's own part; data: for plain images);
 * srcset goes; style loses url(), @import, expression and behavior (sanitizeCss). Links open in a new context
 * (the page catches the click anyway). Quotes get the `dc-quote` class. A tracker (1–2 px, or hidden) always goes.
 *
 * This is the first of three walls. The page loads the result in a frame sandboxed without scripts, and the hub
 * serves it with a CSP that also forbids script and loads nothing but its own images (routes in parts.ts).
 */

import { hostsDiffer, shownHost } from '@dither-chat/protocol';

/** Bump when the output changes: cached copies made by an older pass are made again. */
export const SANITIZE_VERSION = 1;

export interface SanitizeOpts {
  /**
   * Remote images: `block` keeps a placeholder of their size and counts them; `proxy` rewrites them through the hub's
   * image proxy (`proxy`); `drop` takes them out (a reply's quote).
   */
  images: 'block' | 'proxy' | 'drop';
  /** A remote image's URL on the hub (images: 'proxy'). */
  proxy?: (url: string) => string;
  /** A `cid:` part's URL on the hub; null drops it. */
  cid?: (contentId: string) => string | null;
  /** Keep the mail's own <style> blocks (sanitised). False for a reply's quote, where they would style the reply. */
  styles?: boolean;
  /** Keep data: images. */
  dataImages?: boolean;
}

export interface Sanitized {
  /** The body's content, without html, head or body. */
  html: string;
  /** The mail's own body attributes (bgcolor, style, …), sanitised, for the wrapper that stands in for it. */
  body: Record<string, string>;
  remoteImages: number;
  trackers: number;
  /** Content-IDs the HTML refers to (without <>), so those parts are not listed again as files. */
  cids: string[];
  /** Links whose text names another site than they go to. */
  mismatched: { shown: string; goes: string }[];
  /** A quote was marked. */
  quotes: number;
}

// ------------------------------------------------------------------ the lists

/** Kept, with their attributes filtered. */
const ALLOW = new Set(
  (
    'a abbr address article aside b bdi bdo big blockquote br caption center cite code col colgroup dd del details dfn div dl dt em ' +
    'figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q rp rt ruby s samp section ' +
    'small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var wbr style'
  ).split(' '),
);

/**
 * Gone with their content. Includes every element a browser parses as raw text or RCDATA (script, style when not
 * kept, textarea, title, xmp, iframe, noembed, noframes, noscript, plaintext), so the text inside can never come out
 * as markup.
 */
const DROP = new Set(
  (
    'script iframe frame frameset object embed applet param form input button select option optgroup textarea datalist output ' +
    'keygen meter progress link meta base svg math template noscript noembed noframes title xmp plaintext listing canvas audio ' +
    'video source track portal dialog map area'
  ).split(' '),
);

/** The tags that stand for the document itself: their content stays, the tags go. */
const DOCUMENT = new Set(['html', 'head', 'body']);

/** Attributes any kept element may have. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'style', 'title', 'dir', 'lang', 'align', 'valign', 'role']);
const ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace'],
  table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'background', 'summary', 'frame', 'rules'],
  td: ['width', 'height', 'bgcolor', 'background', 'colspan', 'rowspan', 'nowrap', 'scope', 'headers', 'abbr', 'axis'],
  th: ['width', 'height', 'bgcolor', 'background', 'colspan', 'rowspan', 'nowrap', 'scope', 'headers', 'abbr', 'axis'],
  tr: ['height', 'bgcolor', 'background'],
  tbody: ['bgcolor'],
  thead: ['bgcolor'],
  tfoot: ['bgcolor'],
  col: ['width', 'span'],
  colgroup: ['width', 'span'],
  font: ['face', 'size', 'color'],
  hr: ['width', 'size', 'noshade', 'color'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value', 'type'],
  blockquote: ['type'],
  div: ['bgcolor'],
  p: [],
  details: ['open'],
  time: ['datetime'],
  del: ['datetime'],
  ins: ['datetime'],
  style: ['media'],
  body: ['bgcolor', 'background', 'text', 'link', 'vlink', 'alink'],
};

/** Classes and ids mail clients put on the quoted part. `rest`: it and everything after it in its parent. */
const QUOTE_CLASSES = ['gmail_quote', 'protonmail_quote', 'yahoo_quoted', 'moz-cite-prefix', 'gmail_extra'];
const QUOTE_REST_IDS = ['divrplyfwdmsg', 'appendonsend'];

// ------------------------------------------------------------------ entities and escaping

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', sol: '/', tab: '\t', newline: '\n', period: '.',
  comma: ',', excl: '!', num: '#', dollar: '$', percnt: '%', lpar: '(', rpar: ')', ast: '*', midast: '*', plus: '+', equals: '=',
  quest: '?', commat: '@', lsqb: '[', lbrack: '[', rsqb: ']', rbrack: ']', bsol: '\\', lowbar: '_', grave: '`', lcub: '{',
  lbrace: '{', rcub: '}', rbrace: '}', verbar: '|', vert: '|', semi: ';', hyphen: '-', dash: '\u2010', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022', middot: '\u00b7', zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad',
};
/** The ones a browser also reads without the semicolon. */
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg', 'shy']);

/** An attribute value as the browser reads it: character references decoded. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*)(;?)/g, (m, ref: string, semi: string) => {
    if (ref[0] === '#') {
      const n = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // The browser's replacements: NUL, surrogates and out of range become U+FFFD.
      if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(n);
    }
    const name = ref.toLowerCase();
    // Case matters for a few (&Tab; and &tab; are both a tab here; the rest we know are lower case).
    if (NAMED[name] !== undefined && (semi || LEGACY.has(name))) return NAMED[name];
    return m;
  });
}

/**
 * Text for an attribute value written with HTMLRewriter's setAttribute, which quotes it in "…" and escapes `"` but
 * not `&`: an `&` left as it is would be read as a reference again.
 */
const attr = (v: string) => v.replace(/&/g, '&amp;');

/** HTML text, for markup made here. */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ------------------------------------------------------------------ URLs

/** A URL as the browser reads it: no tabs or newlines anywhere, no control characters or spaces at the ends. */
function cleanUrl(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeEntities(raw).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
}

const scheme = (u: string) => u.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1].toLowerCase() ?? null;

/** http(s) as a normalised absolute URL, `//host/…` as https; null for anything else. */
export function webUrl(raw: string): string | null {
  let u = cleanUrl(raw);
  if (u.startsWith('//')) u = 'https:' + u;
  const s = scheme(u);
  if (s !== 'http' && s !== 'https') return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    if (p.username || p.password || !p.hostname) return null;
    return p.href;
  } catch {
    return null;
  }
}

/** A link's href: http(s), mailto, or a place in the mail itself; null otherwise. */
export function safeHref(raw: string): string | null {
  const u = cleanUrl(raw);
  if (u.startsWith('#')) return /^#[^\s"'<>]*$/.test(u) ? u : null;
  const s = scheme(u);
  if (s === 'mailto') return /^mailto:[^\s"'<>]+$/i.test(u) ? u : null;
  return webUrl(u);
}

const DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i;

// ------------------------------------------------------------------ CSS

/** Functions that fetch something, besides url(). Renamed so the browser ignores them. */
const FETCHING = /\b(-webkit-image-set|image-set|image|cross-fade|element|paint|expression|src)\s*\(/gi;

/**
 * CSS without anything that fetches or runs: url() becomes a proxy URL (via `url`) or `none`; @import, @font-face,
 * expression(), behavior, -moz-binding and javascript: are made inert. Escapes that spell letters are read first,
 * so `u\72l(` is caught like `url(`. No `<` survives (the text may sit in a <style> element).
 */
export function sanitizeCss(css: string, url: (u: string) => string | null = () => null): { css: string; remote: number } {
  let remote = 0;
  let s = css
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, '\ufffd')
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    // \72 or \r: an escaped letter, digit, - or _ is that character.
    .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (m, hex: string) => {
      const n = parseInt(hex, 16);
      const c = n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
      return /^[a-zA-Z0-9_-]$/.test(c) ? c : m;
    })
    .replace(/\\([a-zA-Z_-])/g, (m, c: string) => (/^[g-zG-Z_-]$/.test(c) ? c : m));
  // Style sheets from elsewhere go first, so their url() is not counted as an image.
  s = s.replace(/@import\b[^;{}]*;?/gi, '');
  const kept: string[] = [];
  const hold = (x: string) => `\u0001${kept.push(x) - 1}\u0001`;
  s = s.replace(/\burl\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([^"'()\s]*))\s*\)/gi, (_m, a?: string, b?: string, c?: string) => {
    const raw = (a ?? b ?? c ?? '').replace(/\\(.)/g, '$1');
    const to = url(raw);
    if (to === null) {
      if (/^\s*(https?:)?\/\//i.test(raw)) remote++;
      return 'none';
    }
    return hold(`url("${to.replace(/["\\\n<]/g, '')}")`);
  });
  s = s
    // Whatever url( is left was not one the pattern could read: it fetches nothing now.
    .replace(/\burl\s*\(/gi, 'x-blocked(')
    .replace(FETCHING, 'x-blocked(')
    .replace(/@import/gi, '@x-blocked')
    .replace(/@(-[a-z]+-)?(font-face|document)\b/gi, '@x-blocked')
    .replace(/(-moz-binding|behavior|-ms-behavior)\s*:/gi, 'x-blocked:')
    .replace(/(java|vb|live)script\s*:/gi, 'blocked:')
    .replace(/</g, '\\3c ');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => kept[Number(i)]);
  return { css: s, remote };
}

/** Where a remote image would be: its size, kept so the layout holds, and its alt text. Made here, so safe. */
function placeholder(width: string | null, height: string | null, alt: string | null): string {
  const px = (v: string | null) => (v && /^\s*\d{1,4}(\.\d+)?\s*(px)?\s*$/i.test(v) ? Math.round(parseFloat(v)) : null);
  const w = px(width);
  const h = px(height);
  const size = w && h ? `width:${w}px;aspect-ratio:${w}/${h}` : w ? `width:${w}px;height:${Math.min(w, 48)}px` : h ? `width:${h}px;height:${h}px` : 'width:48px;height:32px';
  const label = alt?.trim() ? ` aria-label="${escapeHtml(alt.trim().slice(0, 200))}" title="${escapeHtml(alt.trim().slice(0, 200))}"` : '';
  return `<span class="dc-img-blocked" role="img"${label} style="${size}"></span>`;
}

/** A px length in a style ("1px", "0"), or null. */
const styleLen = (style: string, prop: string): number | null => {
  const m = style.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([0-9.]+)(px)?\\s*(?:!important)?\\s*(?:;|$)`, 'i'));
  return m ? Number(m[1]) : null;
};

/** A 1–2 px image, or one its style hides: it tells the sender the mail was opened, and shows nothing. */
export function isTracker(width: string | null, height: string | null, style: string): boolean {
  if (/(?:^|[;\s])(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)|max-(?:width|height)\s*:\s*0)/i.test(style)) return true;
  const num = (v: string | null) => (v !== null && /^\s*\d+(\.\d+)?\s*(px)?\s*$/i.test(v) ? parseFloat(v) : null);
  const dims = [num(width), num(height), styleLen(style, 'width'), styleLen(style, 'height')].filter((x): x is number => x !== null);
  return dims.length > 0 && dims.every((d) => d <= 2);
}

// ------------------------------------------------------------------ the pass

export function sanitizeMail(input: string, o: SanitizeOpts): Sanitized {
  const out: Sanitized = { html: '', body: {}, remoteImages: 0, trackers: 0, cids: [], mismatched: [], quotes: 0 };
  const cids = new Set<string>();
  const keepStyles = o.styles !== false;
  const cssUrl = (raw: string): string | null => {
    const cid = raw.match(/^\s*cid:(.+)$/i);
    if (cid) {
      const id = contentId(cid[1]);
      cids.add(id);
      return o.cid?.(id) ?? null;
    }
    const web = webUrl(raw);
    if (web && o.images === 'proxy' && o.proxy) return o.proxy(web);
    return null;
  };
  const css = (text: string) => {
    const r = sanitizeCss(text, cssUrl);
    if (o.images === 'block') out.remoteImages += r.remote;
    return r.css;
  };
  /** A remote image's new address, or null when it goes. */
  const image = (raw: string): { src: string | null; remote: boolean } => {
    const u = cleanUrl(raw);
    if (/^cid:/i.test(u)) {
      const id = contentId(u.slice(4));
      cids.add(id);
      return { src: o.cid?.(id) ?? null, remote: false };
    }
    if (/^data:/i.test(u)) return { src: o.dataImages !== false && DATA_IMAGE.test(u) ? u : null, remote: false };
    const web = webUrl(u);
    if (!web) return { src: null, remote: false };
    return { src: o.images === 'proxy' && o.proxy ? o.proxy(web) : null, remote: true };
  };

  // The link being read, for its text.
  let link: { href: string; text: string } | null = null;
  let styleText = '';

  const rw = new HTMLRewriter()
    .onDocument({
      comments: (c) => void c.remove(),
      doctype: (d) => void d.remove(),
    })
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROP.has(tag) || (tag === 'style' && !keepStyles)) return void el.remove();
        const isDoc = DOCUMENT.has(tag);
        if (!ALLOW.has(tag) && !isDoc) return void el.removeAndKeepContent();
        const raw = new Map<string, string>();
        for (const [n, v] of el.attributes) if (!raw.has(n.toLowerCase())) raw.set(n.toLowerCase(), v);
        for (const n of [...raw.keys()]) el.removeAttribute(n);
        const allowed = new Set([...GLOBAL_ATTRS, ...(ATTRS[tag] ?? [])]);
        const keep: [string, string][] = [];
        const get = (n: string) => (raw.has(n) ? decodeEntities(raw.get(n)!) : null);
        let style = get('style') ?? '';

        if (tag === 'img') {
          const src = raw.get('src') ?? '';
          const r = image(src);
          if (r.remote && isTracker(get('width'), get('height'), style)) {
            out.trackers++;
            return void el.remove();
          }
          if (r.src) keep.push(['src', r.src]);
          else if (r.remote && o.images === 'block') {
            // A placeholder of the same size, so the layout holds.
            out.remoteImages++;
            return void el.replace(placeholder(get('width'), get('height'), get('alt')), { html: true });
          } else return void el.remove();
        }
        if (raw.has('background') && allowed.has('background')) {
          const r = image(raw.get('background')!);
          if (r.src) keep.push(['background', r.src]);
          else if (r.remote && o.images === 'block') out.remoteImages++;
        }

        for (const [n] of raw) {
          if (!allowed.has(n) || n === 'src' || n === 'background' || n === 'style') continue;
          const v = get(n)!;
          if (n === 'href') {
            const h = safeHref(raw.get(n)!);
            if (h) keep.push(['href', h]);
            continue;
          }
          if (n === 'class') {
            const cls = v.split(/\s+/).filter((c) => c && !/^dc-/i.test(c));
            if (cls.length) keep.push(['class', cls.join(' ')]);
            continue;
          }
          keep.push([n, v]);
        }
        if (style) {
          style = css(style).trim();
          if (style) keep.push(['style', style]);
        }

        // Quotes.
        const classes = (get('class') ?? '').toLowerCase().split(/\s+/);
        const id = (get('id') ?? '').toLowerCase();
        const rest = QUOTE_REST_IDS.includes(id);
        if (rest || (tag === 'blockquote' && (get('type') ?? '').toLowerCase() === 'cite') || QUOTE_CLASSES.some((c) => classes.includes(c))) {
          out.quotes++;
          const at = keep.findIndex(([n]) => n === 'class');
          if (at >= 0) keep[at] = ['class', `${keep[at][1]} dc-quote`];
          else keep.push(['class', 'dc-quote']);
          if (rest) keep.push(['data-dc-quote', 'rest']);
        }

        if (isDoc) {
          if (tag === 'body') for (const [n, v] of keep) if (n !== 'id' && n !== 'class') out.body[n] = v;
          return void el.removeAndKeepContent();
        }
        if (tag === 'a') {
          keep.push(['target', '_blank'], ['rel', 'noopener noreferrer']);
          const href = keep.find(([n]) => n === 'href')?.[1];
          if (href && /^https?:/i.test(href)) {
            const current = { href, text: '' };
            link = current;
            el.onEndTag(() => {
              const shown = shownHost(current.text);
              const goes = new URL(current.href).hostname;
              if (shown && hostsDiffer(shown, goes) && out.mismatched.length < 20) out.mismatched.push({ shown, goes });
              if (link === current) link = null;
            });
          }
        }
        for (const [n, v] of keep) el.setAttribute(n, attr(v));
      },
    })
    .on('a', {
      text(t) {
        if (link) link.text += t.text;
      },
    })
    .on('style', {
      text(t) {
        styleText += t.text;
        if (!t.lastInTextNode) return void t.remove();
        // The whole sheet at once; it holds no `<`, so it cannot close the element early.
        t.replace(css(styleText), { html: true });
        styleText = '';
      },
    });
  const html = rw.transform(input);
  // A tag the input left open at its very end comes out as it went in, past every handler. A browser drops it at
  // the end of a document, but here more markup follows (our wrapper), which would close it: it goes.
  const cut = danglingTag(html);
  out.html = cut === null ? html : html.slice(0, cut);
  out.cids = [...cids];
  return out;
}

const RAW_TEXT = new Set(['style', 'script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

/**
 * Where a tag (or doctype) that never closes starts in `html`, reading it as a browser's tokenizer does; null when
 * everything closes. Comments are gone already and the style sheets hold no `<`, so this only follows tags,
 * their quoted values, and the raw text of the elements a browser reads that way.
 */
export function danglingTag(html: string): number | null {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return null;
    const c = html[lt + 1] ?? '';
    if (c === '!' || c === '?' || (c === '/' && !/[a-zA-Z]/.test(html[lt + 2] ?? ''))) {
      // A comment, a doctype or a bogus comment: to the end of a comment, or to the next `>`.
      const close = html.startsWith('<!--', lt) ? html.indexOf('-->', lt + 4) : html.indexOf('>', lt + 2);
      if (close < 0) return lt;
      i = close + (html.startsWith('<!--', lt) ? 3 : 1);
      continue;
    }
    const end = c === '/';
    if (!/[a-zA-Z]/.test(end ? (html[lt + 2] ?? '') : c)) {
      i = lt + 1;
      continue;
    }
    // A tag: its name, then attributes, quoted values may hold `>`.
    let j = lt + (end ? 2 : 1);
    while (j < n && !/[\s/>]/.test(html[j])) j++;
    const name = html.slice(lt + (end ? 2 : 1), j).toLowerCase();
    let quote: string | null = null;
    let closed = -1;
    let eq = false;
    for (; j < n; j++) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '>') {
        closed = j;
        break;
      }
      if (eq && (ch === '"' || ch === "'")) quote = ch;
      if (ch === '=') eq = true;
      else if (!/\s/.test(ch)) eq = false;
    }
    if (closed < 0) return lt;
    i = closed + 1;
    if (!end && RAW_TEXT.has(name)) {
      // Raw text up to its own end tag.
      const m = new RegExp(`</${name}[\\s/>]`, 'i').exec(html.slice(i));
      if (!m) return null;
      i += m.index;
    }
  }
  return null;
}

/** A Content-ID as kept on a part: no angle brackets, percent-decoded where a cid: URL encoded it. */
export function contentId(s: string): string {
  let v = s.trim();
  try {
    v = decodeURIComponent(v);
  } catch {}
  return v.replace(/^<|>$/g, '').trim().toLowerCase();
}

// ------------------------------------------------------------------ the document

/** The frame's own style: a white sheet in every theme, images no wider than the page, the placeholder. */
const BASE_CSS = `html,body{margin:0;padding:0;background:#fff;color:#1f2328;overflow:hidden}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:break-word;-webkit-text-size-adjust:100%}
.dc-mail{display:flow-root;padding:12px 14px;box-sizing:border-box}
.dc-mail img{max-width:100%;height:auto}
.dc-mail pre{white-space:pre-wrap}
.dc-mail a{color:#0b62d6}
.dc-mail blockquote[type=cite]{margin:0 0 0 2px;padding-left:10px;border-left:2px solid #c9d1d9;color:#57606a}
.dc-img-blocked{display:inline-block;max-width:100%;vertical-align:middle;background:#eef1f4 repeating-linear-gradient(45deg,#eef1f4 0 8px,#e3e7eb 8px 16px);border:1px dashed #c9d1d9;box-sizing:border-box}
.dc-folded{display:none!important}
.dc-fold{display:block;margin:8px 0 2px;padding:0 9px;border:1px solid #d0d7de;border-radius:999px;background:#f6f8fa;color:#57606a;font:12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;cursor:pointer}`;

/** The whole document the frame loads: the base style, then the mail in a wrapper that stands in for its body. */
export function mailDocument(s: Sanitized): string {
  const color = (v: string | undefined) => (v && /^#?[0-9a-z]+$/i.test(v) ? v : null);
  // background was rewritten already: the hub's own URL or a data: image.
  const bg = s.body.background && /^(\/api\/mail\/[\w./%-]+|data:image\/[a-z]+;base64,[a-z0-9+/=]+)$/i.test(s.body.background) ? s.body.background : null;
  const bodyStyle = [color(s.body.bgcolor) && `background-color:${s.body.bgcolor}`, color(s.body.text) && `color:${s.body.text}`, bg && `background-image:url("${bg}")`, s.body.style ?? '']
    .filter(Boolean)
    .join(';');
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer">` +
    `<style>${BASE_CSS}</style></head><body><div class="dc-mail"${bodyStyle ? ` style="${escapeHtml(bodyStyle)}"` : ''}>${s.html}</div></body></html>`
  );
}

/**
 * The original's HTML for a reply's or a forward's quote (slice 5, compose.ts quotedHtml): sanitised with no images,
 * none of its style sheets and no data: pictures, as the inside of the quote.
 */
export function quoteFragment(originalHtml: string): string {
  return sanitizeMail(originalHtml, { images: 'drop', styles: false, dataImages: false }).html;
}
