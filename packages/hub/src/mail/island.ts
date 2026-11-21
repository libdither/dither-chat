/**
 * The mail editor's HTML on the hub (docs/mail.md "Writing"): islands made from an original for a forward or a quote,
 * and the editor's HTML made into the mail that goes.
 *
 * An island is the original's HTML sanitised with its style sheets kept, then written into each element's own `style`
 * (`inlineCss`), because many mail apps drop a `<style>` (Gmail outside the head, most web mail inside a forward): the
 * forward keeps its look wherever it lands. What a sheet says that one element's style can't (@media, :hover, `a + b`)
 * stays in a small sheet scoped to the island. Trackers are gone; each picture from the web keeps its address as
 * `data-dc-src`, so the sender chooses when sending what happens to it (MailOutgoingPictures):
 *
 *   link   the address as it is: the recipient's app fetches it (a personal one can tell the original sender)
 *   embed  the hub fetches it now and it goes inside the mail as a part (`cid:`): nothing is fetched on their end
 *   drop   left out
 *
 * Pictures pasted in (`data:` URLs) always go inside the mail: as parts when the account sends them (details.inlineParts),
 * else as `data:` URLs.
 */
import { createHash } from 'node:crypto';
import type * as P from '@dither-chat/protocol';
import { QUOTE_STYLE } from '@dither-chat/protocol/mail-markdown';
import { attribution, forwardBlock, quoteLines, textHtml, type ComposeOriginal } from './compose.ts';
import { decodeEntities, sanitizeCss } from './sanitize.ts';
import { htmlText } from './store.ts';

// ------------------------------------------------------------------ style sheets into style attributes

interface Rule {
  selector: string;
  decls: string[];
  important: string[];
  spec: number;
  order: number;
}

/** The sheet's top-level blocks: `prelude { body }`, braces matched, strings respected. */
function blocks(css: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    let quote = '';
    for (; j < css.length && depth; j++) {
      const c = css[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

/** Splits on `sep` outside quotes, brackets and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && !depth) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** a-b-c specificity as one number (ids, then classes, attributes and pseudo-classes, then types). */
export function specificity(sel: string): number {
  const s = sel.replace(/\([^)]*\)/g, '()').replace(/\[[^\]]*\]/g, '[]');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[\]|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[\]|::?[\w-]+(\(\))?/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/** What an element's own style can take: simple selectors HTMLRewriter matches, nothing that depends on state. */
const INLINABLE = /^[\w\s.#*>:()[\]="'^$|~-]+$/;
const SAFE_PSEUDO = /:(?!first-child\b|nth-child\(|first-of-type\b|nth-of-type\(|not\()/;
function inlinable(sel: string): boolean {
  return INLINABLE.test(sel) && !SAFE_PSEUDO.test(sel) && !/[~+]/.test(sel.replace(/\[[^\]]*\]/g, '')) && !/::/.test(sel);
}

/** `body`, `html` and `html body` stand for the island's root; `body x` for x anywhere in it. */
function rooted(sel: string, root: string): string {
  const t = sel.trim();
  if (/^(html|body|html\s*>?\s*body)$/i.test(t)) return root;
  const m = /^(?:html\b\s*>?\s*)?body\b\s*>?\s*(.+)$/i.exec(t) ?? /^html\b\s*>?\s*(.+)$/i.exec(t);
  return m ? m[1] : t;
}

function declarations(body: string): { normal: string[]; important: string[] } {
  const normal: string[] = [];
  const important: string[] = [];
  for (const d of splitTop(body, ';')) {
    if (!/^[\w-]+\s*:/.test(d)) continue;
    if (/!\s*important\s*$/i.test(d)) important.push(d.replace(/\s*!\s*important\s*$/i, '') + ' !important');
    else normal.push(d);
  }
  return { normal, important };
}

/**
 * The HTML's `<style>` blocks written into each element's `style`, in the order CSS applies them (specificity, then
 * the sheet's order; the element's own style over the sheet's, `!important` over both). What can't go into one element
 * stays in a sheet whose selectors start at the island's root (`.dc-isl-<ref>`), so it touches nothing else in the mail.
 */
export function inlineCss(html: string, rootClass: string): string {
  let sheet = '';
  const without = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, css: string) => {
    // `<style><!-- … --></style>` or `<![CDATA[ … ]]>`, as old newsletters hide their sheet from older mail apps: the
    // marks are not CSS.
    sheet += `${css.replace(/<!--|-->|<!\[CDATA\[|\]\]>/g, ' ')}\n`;
    return '';
  });
  if (!sheet.trim()) return html;
  const root = `.${rootClass}`;
  const rules: Rule[] = [];
  const rest: string[] = [];
  let order = 0;
  const scope = (sel: string) => {
    const r = rooted(sel, root);
    return r === root ? root : `${root} ${r}`;
  };
  for (const b of blocks(sheet)) {
    if (b.prelude.startsWith('@')) {
      // @media and the like: kept, scoped to the island.
      if (/^@media\b/i.test(b.prelude)) {
        const inner = blocks(b.body)
          .filter((x) => !x.prelude.startsWith('@'))
          .map((x) => `${splitTop(x.prelude, ',').map(scope).join(',')}{${x.body}}`)
          .join('');
        if (inner) rest.push(`${b.prelude}{${inner}}`);
      }
      continue;
    }
    const { normal, important } = declarations(b.body);
    if (!normal.length && !important.length) continue;
    for (const sel of splitTop(b.prelude, ',')) {
      if (inlinable(sel)) rules.push({ selector: rooted(sel, root), decls: normal, important, spec: specificity(sel), order: order++ });
      else rest.push(`${scope(sel)}{${b.body}}`);
    }
  }
  rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
  // The element's own style goes after the sheet's, and its own `!important` after the sheet's `!important`.
  const OWN = 'data-dc-own';
  const OWN_IMPORTANT = 'data-dc-own-imp';
  const append = (el: HTMLRewriterTypes.Element, decls: string[]) => {
    if (!decls.length) return;
    const was = el.getAttribute('style') ?? '';
    el.setAttribute('style', `${was}${was && !/;\s*$/.test(was) ? ';' : ''}${decls.join(';')}`);
  };
  let rw = new HTMLRewriter().on('*', {
    element(el) {
      const own = el.getAttribute('style');
      if (own !== null) {
        if (/!\s*important/i.test(own)) {
          const d = declarations(own);
          el.setAttribute(OWN, d.normal.join(';'));
          el.setAttribute(OWN_IMPORTANT, d.important.join(';'));
        } else el.setAttribute(OWN, own);
        el.removeAttribute('style');
      }
    },
  });
  const usable = (sel: string) => {
    try {
      new HTMLRewriter().on(sel, {});
      return true;
    } catch {
      return false;
    }
  };
  const live = rules.filter((r) => {
    if (usable(r.selector)) return true;
    rest.push(`${scope(r.selector)}{${[...r.decls, ...r.important].join(';')}}`);
    return false;
  });
  for (const r of live) rw = rw.on(r.selector, { element: (el) => append(el, r.decls) });
  rw = rw.on('*', {
    element(el) {
      const own = el.getAttribute(OWN);
      if (own !== null) {
        el.removeAttribute(OWN);
        if (own) append(el, [own]);
      }
    },
  });
  for (const r of live) if (r.important.length) rw = rw.on(r.selector, { element: (el) => append(el, r.important) });
  rw = rw.on('*', {
    element(el) {
      const own = el.getAttribute(OWN_IMPORTANT);
      if (own !== null) {
        el.removeAttribute(OWN_IMPORTANT);
        if (own) append(el, [own]);
      }
    },
  });
  const done = rw.transform(without);
  const left = rest.length ? sanitizeCss(rest.join('\n')).css : '';
  return left.trim() ? `<style>${left}</style>${done}` : done;
}

// ------------------------------------------------------------------ islands

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/** The island's body style: the original's own body attributes, as a style. */
function bodyStyle(body: Record<string, string>): string {
  const color = (v: string | undefined) => (v && /^#?[0-9a-z]+$/i.test(v) ? v : null);
  return [color(body.bgcolor) && `background-color:${body.bgcolor}`, color(body.text) && `color:${body.text}`, body.style ?? ''].filter(Boolean).join(';');
}

/**
 * What an island says, as a fingerprint: its text with the tags and spacing gone, so the same island through a
 * browser's parser (the HTML view: other quoting, entities written out, new lines between blocks) has the same one,
 * and an island whose words were edited has another.
 */
export function islandPrint(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(text).digest('base64url').slice(0, 16);
}

/** The island as the hub made it: its fingerprint (`data-dc-text`, on its head) still matches what it says. */
function islandAsMade(html: string): boolean {
  const said = /\bdata-dc-text="([\w-]+)"/.exec(html)?.[1];
  return !!said && said === islandPrint(html);
}

/** Text with `\r\n` as `\n`, at most one empty line in a row, no trailing space. */
const tidyText = (t: string) => t.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

/**
 * An island's part of the mail's text part (outgoingText): a forward's headers and the original's own text, or the
 * attribution and its text quoted, as a plain-text mail has them; when the island was edited (in the HTML view), or
 * the original had no text, its text is the island's own HTML's, a quote's quoted.
 */
export function islandText(i: { kind: string; html: string }, o: ComposeOriginal | null, tz?: string): string {
  const own = !o || !islandAsMade(i.html) || !(o.text ?? '').trim();
  if (i.kind === 'forward' && o && !own) {
    const f = forwardBlock(o, tz);
    return tidyText(`${f.head}\n\n${f.text}`);
  }
  if (i.kind === 'quote' && o && !own) return tidyText(`${attribution(o, tz)}\n${quoteLines(o.text)}`);
  if (i.kind === 'quote') {
    // The attribution, then what is inside the quote, quoted.
    const at = i.html.search(/<blockquote\b/i);
    if (at >= 0) {
      const head = htmlText(i.html.slice(0, at)).trim();
      const body = quoteLines(htmlText(i.html.slice(at)));
      return tidyText(head ? `${head}\n${body}` : body);
    }
  }
  return tidyText(htmlText(i.html));
}

/**
 * A forward's or a quote's island: the forwarded-message lines or the attribution, then the original's HTML (`content`:
 * sanitised with its sheets and pictures kept, sanitize.ts keepSource), its sheets inlined; or its text when it had no HTML.
 * Its head carries its fingerprint (`data-dc-text`), so the text part knows whether it was edited (islandText); and
 * `textBytes` is what it adds to the text part.
 */
export function islandOf(kind: 'forward' | 'quote', o: ComposeOriginal, content: { html: string; body: Record<string, string> } | null, ref: string, tz?: string): P.MailIsland {
  const rootClass = `dc-isl-${ref}`;
  const style = content ? bodyStyle(content.body) : '';
  const wrapped = `<div class="${rootClass}"${style ? ` style="${esc(style)}"` : ''}>${content ? content.html : textHtml((o.text ?? '').replace(/\s+$/, ''))}</div>`;
  // The sheets apply with the wrapper standing in for the original's body.
  const root = content ? inlineCss(wrapped, rootClass) : wrapped;
  const who = o.from.name || o.from.email;
  const when = new Date(o.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(tz ? { timeZone: tz } : {}) });
  const head = kind === 'forward' ? `<div class="dc-forward-head" style="color:#57606a;margin:0 0 10px">${textHtml(forwardBlock(o, tz).head)}</div>` : `<div class="dc-quote-head">${esc(attribution(o, tz))}</div>`;
  const body = kind === 'forward' ? root : `<blockquote type="cite" style="${QUOTE_STYLE}">${root}</blockquote>`;
  // The fingerprint is of the text alone, so writing it into the head changes nothing it covers.
  const html = `${head.replace(/^<div /, `<div data-dc-text="${islandPrint(head + body)}" `)}${body}`;
  const text = islandText({ kind, html }, o, tz);
  return { kind, label: `${who}, ${when}`, html, text, textBytes: Buffer.byteLength(text) };
}

// ------------------------------------------------------------------ the mail that goes

/** One picture that goes inside the mail. */
interface InlinePart {
  contentId: string;
  mime: string;
  bytes: Buffer;
  name: string;
}

export interface OutgoingCtx {
  pictures: P.MailOutgoingPictures;
  /** With Link, link the ones that can tell too; else they are left out (counted in leftOut.canTell). */
  linkCanTell?: boolean;
  /** The account takes inline parts (details.inlineParts); else pictures inside the mail are data: URLs. */
  inlineParts: boolean;
  /** A picture of this hub's (its proxy, an original's cid: part) as the address it stands for, or its bytes. */
  resolve: (src: string) => { url: string } | { cid: { messageId: string; contentId: string } } | null;
  /** A picture's bytes, for embedding: through the hub's image cache. */
  fetchPicture: (url: string) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** A picture's bytes only when the hub has them already (fetching it now would make no request). */
  cachedPicture: (url: string) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** The picture can tell its sender it was opened (pictures.ts: personal or tracker): embedded only from the cache. */
  canTell: (url: string) => boolean;
  /** An original's inline part's bytes. */
  cidPart: (messageId: string, contentId: string) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** Names the parts made (the same on every try of one send). */
  id: string;
}

interface Outgoing {
  html: string;
  inline: InlinePart[];
  /** Bytes of the pictures that go inside the mail (as parts or as `data:`), before base64: what the cap counts. */
  insideBytes: number;
  /** What happened to the pictures (backgrounds too), each once, for the outbox's log and the tests. */
  linked: number;
  embedded: number;
  dropped: number;
  failed: number;
  /**
   * Pictures that were to go and were left out instead: their bytes could not be had (`failed`), or they would tell the
   * original sender (`canTell`: with Embed, a personal one the hub did not have; with Link, every one that can tell,
   * unless `linkCanTell`).
   */
  leftOut: { failed: number; canTell: number };
}

/** Tags the mail never carries, whatever the HTML view held. */
const NEVER = 'script, iframe, object, embed, base, meta, link, form, input, button, select, textarea, frame, frameset, applet, noscript';
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
/** Attributes that hold an address a click or the page follows. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'cite', 'longdesc', 'lowsrc', 'dynsrc', 'data']);

/**
 * A `javascript:` (or vbscript:, livescript:) address however it is written: entities decoded (`java&#9;script:`),
 * then every space and control character gone, as a browser's URL parser drops tabs and new lines anywhere.
 */
export function scriptUrl(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^(java|vb|live)script:/i.test(decodeEntities(v).replace(/[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ''));
}

/** Whether a style or a sheet may fetch something: any url(), or an escape that could spell one. */
const mayFetch = (css: string) => /url\s*\(|\\|image-set|image\s*\(|cross-fade|element\s*\(|paint\s*\(|@import|@font-face|expression|src\s*\(|binding|behavior/i.test(css);

/**
 * `image-set("a.png" 1x, url(b.png) 2x)` as `url("a.png")`, its first choice: one picture that goes as the others do.
 * (sanitizeCss makes whatever else fetches inert.)
 */
function imageSets(css: string): string {
  const re = /(?:-webkit-)?image-set\s*\(/gi;
  let out = '';
  let from = 0;
  for (let m; (m = re.exec(css)); ) {
    let depth = 1;
    let quote = '';
    let j = m.index + m[0].length;
    for (; j < css.length && depth; j++) {
      const c = css[j];
      if (quote) {
        if (c === '\\') j++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const first = splitTop(css.slice(m.index + m[0].length, depth ? j : j - 1), ',')[0] ?? '';
    const str = /^(["'])((?:\\.|(?!\1)[^\\])*)\1/.exec(first);
    out += css.slice(from, m.index) + (/^url\s*\([^)]*\)/i.exec(first)?.[0] ?? (str ? `url(${str[0]})` : 'none'));
    from = j;
    re.lastIndex = j;
  }
  return out + css.slice(from);
}

/** An attribute's value as text (HTMLRewriter gives it as written, entities and all), and back. */
const attr = (el: HTMLRewriterTypes.Element, name: string) => {
  const v = el.getAttribute(name);
  return v === null ? null : decodeEntities(v);
};
const setAttr = (el: HTMLRewriterTypes.Element, name: string, v: string) => el.setAttribute(name, v.replace(/&/g, '&amp;'));

/**
 * The editor's HTML as the mail's HTML part: scripts and the editor's own marks gone, pasted pictures as parts (or
 * `data:`), pictures from the web linked, embedded or dropped (`ctx.pictures`), this hub's addresses never leaving it.
 * Backgrounds (a `background` attribute, a style's or a sheet's `url()` and `image-set()`), a video's poster and an SVG
 * `<image>` go the same way as pictures. Embed sends nothing that fetches on their end: a picture whose bytes can't be
 * had is left out, and so is one that can tell (`ctx.canTell`) unless the hub has it already, since fetching it now
 * would tell the original sender. Video and audio are not pictures: linked as they are, else left out.
 */
export async function outgoingHtml(html: string, ctx: OutgoingCtx): Promise<Outgoing> {
  const out: Outgoing = { html: '', inline: [], insideBytes: 0, linked: 0, embedded: 0, dropped: 0, failed: 0, leftOut: { failed: 0, canTell: 0 } };
  // First pass: every picture, background and poster, by what its address is.
  type Pic = { kind: 'data'; mime: string; b64: string } | { kind: 'web'; url: string } | { kind: 'cid'; messageId: string; contentId: string } | { kind: 'none' };
  const what = (src: string, original: string | null): Pic => {
    if (original && /^https?:\/\//i.test(original)) return { kind: 'web', url: original };
    const d = DATA_IMAGE.exec(src);
    if (d) return { kind: 'data', mime: d[1].toLowerCase(), b64: d[2].replace(/\s+/g, '') };
    const r = ctx.resolve(src);
    if (r && 'url' in r) return { kind: 'web', url: r.url };
    if (r && 'cid' in r) return { kind: 'cid', ...r.cid };
    if (/^https?:\/\//i.test(src)) return { kind: 'web', url: src };
    return { kind: 'none' };
  };
  const key = (p: Pic) => (p.kind === 'data' ? `d:${p.b64.length}:${p.b64.slice(0, 64)}:${p.b64.slice(-64)}` : p.kind === 'web' ? `w:${p.url}` : p.kind === 'cid' ? `c:${p.messageId}:${p.contentId}` : 'none');
  const srcs: { src: string; original: string | null }[] = [];
  /** Pictures the island held because they can tell (its `data-dc-held`), whatever ctx.canTell says. */
  const heldTells = new Set<string>();
  const cssRefs = (css: string) => {
    if (!mayFetch(css)) return;
    sanitizeCss(imageSets(css), (u) => {
      srcs.push({ src: u.trim(), original: null });
      return null;
    });
  };
  let sheet = '';
  new HTMLRewriter()
    .on('img', {
      element(el) {
        const s = { src: (attr(el, 'src') ?? '').trim(), original: attr(el, 'data-dc-src') };
        srcs.push(s);
        if (/^(personal|tracker)$/.test(attr(el, 'data-dc-held') ?? '')) heldTells.add(key(what(s.src, s.original)));
      },
    })
    // A video's poster only when linking: embedding and leaving out take the video out whole.
    .on('video[poster]', { element: (el) => void (ctx.pictures === 'link' && srcs.push({ src: (attr(el, 'poster') ?? '').trim(), original: null })) })
    .on('svg image', {
      element(el) {
        srcs.push({ src: (attr(el, 'href') ?? attr(el, 'xlink:href') ?? '').trim(), original: null });
      },
    })
    .on('*', {
      element(el) {
        const bg = attr(el, 'background');
        if (bg !== null) srcs.push({ src: bg.trim(), original: null });
        const style = attr(el, 'style');
        if (style) cssRefs(style);
      },
    })
    .on('style', {
      text(t) {
        sheet += t.text;
        if (t.lastInTextNode) {
          cssRefs(sheet);
          sheet = '';
        }
      },
    })
    .transform(html);
  // Each distinct picture once: its part, or its data: URL, or its address.
  const made = new Map<string, string | null>();
  const part = (bytes: Buffer, mime: string): string => {
    out.insideBytes += bytes.length;
    if (!ctx.inlineParts) return `data:${mime};base64,${bytes.toString('base64')}`;
    const n = out.inline.length + 1;
    const contentId = `dc${n}.${ctx.id.replace(/[^\w]/g, '').slice(-16)}@dither`;
    out.inline.push({ contentId, mime, bytes, name: `picture-${n}.${EXT[mime] ?? 'img'}` });
    return `cid:${contentId}`;
  };
  const jobs = new Map<string, Pic>();
  for (const s of srcs) {
    const p = what(s.src, s.original);
    jobs.set(key(p), p);
  }
  const failed = () => {
    out.failed++;
    out.leftOut.failed++;
    return null;
  };
  await Promise.all(
    [...jobs].map(async ([k, p]) => {
      if (p.kind === 'none') return void made.set(k, null);
      if (p.kind === 'data') return void made.set(k, part(Buffer.from(p.b64, 'base64'), p.mime));
      if (p.kind === 'cid') {
        const got = await ctx.cidPart(p.messageId, p.contentId).catch(() => null);
        return void made.set(k, got ? part(got.bytes, got.mime) : failed());
      }
      if (ctx.pictures === 'drop') return void made.set(k, null);
      if (ctx.pictures === 'link') {
        // Linking one that can tell lets the original sender know it was opened: left out unless asked for.
        if (!ctx.linkCanTell && (heldTells.has(k) || ctx.canTell(p.url))) {
          out.leftOut.canTell++;
          return void made.set(k, null);
        }
        return void made.set(k, p.url);
      }
      // Embed: one that can tell only from the cache (fetching it now would tell); none linked instead.
      if (heldTells.has(k) || ctx.canTell(p.url)) {
        const got = await ctx.cachedPicture(p.url).catch(() => null);
        if (!got) out.leftOut.canTell++;
        return void made.set(k, got ? part(got.bytes, got.mime) : null);
      }
      const got = await ctx.fetchPicture(p.url).catch(() => null);
      made.set(k, got ? part(got.bytes, got.mime) : failed());
    }),
  );
  // Order the parts as they first appear, so the same draft makes the same mail.
  const firstSeen = srcs.map((s) => key(what(s.src, s.original)));
  out.inline.sort((a, b) => firstSeen.findIndex((k) => made.get(k) === `cid:${a.contentId}`) - firstSeen.findIndex((k) => made.get(k) === `cid:${b.contentId}`));

  const counted = new Set<string>();
  /** Where one picture goes in the mail (null: left out), counted the first time. */
  const to = (src: string, original: string | null, img = false): string | null => {
    const p = what(src, original);
    const k = key(p);
    const at = made.get(k) ?? null;
    // An img that stands for nothing is a picture left out; a url() that does (`url(#filter)`) is no picture.
    if ((img || p.kind !== 'none') && !counted.has(k)) {
      counted.add(k);
      if (!at) out.dropped++;
      else if (at.startsWith('cid:') || at.startsWith('data:')) out.embedded++;
      else out.linked++;
    }
    return at;
  };
  /** A style or a sheet with each url() where its picture goes, or `none`; nothing else in it fetches either. */
  const css = (text: string) => (mayFetch(text) ? sanitizeCss(imageSets(text), (u) => to(u.trim(), null)).css : text);
  /** Video and audio: their own address when linking (this hub's never), else nothing. */
  const media = (v: string | null): string | null => {
    if (v === null || ctx.pictures !== 'link') return null;
    const r = ctx.resolve(v.trim());
    if (r) return 'url' in r ? r.url : null;
    return /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
  };
  // The img handler reads data-dc-src before the * one takes the editor's marks off.
  out.html = new HTMLRewriter()
    .on(NEVER, { element: (el) => void el.remove() })
    .on('img', {
      element(el) {
        const at = to((attr(el, 'src') ?? '').trim(), attr(el, 'data-dc-src'), true);
        if (!at) return void el.remove();
        setAttr(el, 'src', at);
        el.removeAttribute('data-dc-src');
        el.removeAttribute('data-dc-held');
      },
    })
    .on('svg image', {
      element(el) {
        const at = to((attr(el, 'href') ?? attr(el, 'xlink:href') ?? '').trim(), null, true);
        if (!at) return void el.remove();
        el.removeAttribute('xlink:href');
        setAttr(el, 'href', at);
      },
    })
    .on('video, audio', {
      element(el) {
        // Embed and Leave out: no player that fetches on their end; what it holds for apps without one stays.
        if (ctx.pictures !== 'link') return void el.removeAndKeepContent();
        if (el.hasAttribute('poster')) {
          const at = to((attr(el, 'poster') ?? '').trim(), null);
          if (at) setAttr(el, 'poster', at);
          else el.removeAttribute('poster');
        }
        const at = media(attr(el, 'src'));
        if (at) setAttr(el, 'src', at);
        else el.removeAttribute('src');
      },
    })
    .on('source, track', {
      element(el) {
        const at = media(attr(el, 'src'));
        if (!at) return void el.remove();
        setAttr(el, 'src', at);
      },
    })
    .on('*', {
      element(el) {
        for (const [n, v] of [...el.attributes]) {
          const name = n.toLowerCase();
          if (name.startsWith('on') || name.startsWith('data-dc-') || name === 'contenteditable' || name === 'srcset' || name === 'lowsrc' || name === 'dynsrc') el.removeAttribute(n);
          else if (URL_ATTRS.has(name) && scriptUrl(v)) el.removeAttribute(n);
        }
        const cls = el.getAttribute('class');
        if (cls !== null) {
          const keep = cls.split(/\s+/).filter((c) => c && !/^(dc-quote|dc-folded)$/.test(c));
          if (keep.length) el.setAttribute('class', keep.join(' '));
          else el.removeAttribute('class');
        }
        // Backgrounds: as the pictures go (this hub's addresses never leave).
        const bg = attr(el, 'background');
        if (bg !== null) {
          const at = to(bg.trim(), null);
          if (at) setAttr(el, 'background', at);
          else el.removeAttribute('background');
        }
        const style = attr(el, 'style');
        if (style && mayFetch(style)) setAttr(el, 'style', css(style));
      },
    })
    .on('style', {
      text(t) {
        sheet += t.text;
        if (!t.lastInTextNode) return void t.remove();
        t.replace(css(sheet), { html: true });
        sheet = '';
      },
    })
    .transform(html);
  return out;
}

// ------------------------------------------------------------------ the text part

/** The editor's islands, by ref, from its HTML: their kind and HTML. */
export function islandsOf(html: string): Map<string, { kind: string; html: string }> {
  const out = new Map<string, { kind: string; html: string }>();
  const re = /<div\b[^>]*\bdata-dc-island="([^"]*)"[^>]*>/gi;
  for (let m; (m = re.exec(html)); ) {
    const ref = /\bdata-dc-ref="([^"]*)"/.exec(m[0])?.[1];
    // Its own close: count the divs inside it.
    let depth = 1;
    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = m.index + m[0].length;
    let end = html.length;
    for (let t; (t = tag.exec(html)); ) {
      depth += t[1] ? -1 : 1;
      if (!depth) {
        end = t.index;
        break;
      }
    }
    if (ref) out.set(ref, { kind: m[1], html: html.slice(m.index + m[0].length, end) });
    re.lastIndex = end;
  }
  return out;
}

/** Tags that are a block of their own: a line break before and after them in text. */
const BLOCK_TAGS = 'p|div|h[1-6]|ul|ol|dl|dt|dd|blockquote|pre|table|thead|tbody|tfoot|tr|caption|section|article|header|footer|aside|nav|main|figure|figcaption|center|address';
/** Tags that only mark text: gone, their text kept. */
const INLINE_TAGS = 'span|font|b|strong|i|em|u|s|del|ins|strike|code|sub|sup|mark|small|big|abbr|cite|q|kbd|samp|var|label|time|th|td|li|a|img|br|hr|wbr|col|colgroup|picture|source|video|audio|svg|image|html|head|body|title';
const TAG = new RegExp(`<\\/?(?:${BLOCK_TAGS}|${INLINE_TAGS})(?=[\\s/>])[^<>]*>`, 'gi');
const BLOCK = new RegExp(`<\\/?(?:${BLOCK_TAGS})(?=[\\s/>])[^<>]*>`, 'gi');
const attrOf = (tag: string, name: string) => decodeEntities(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? '');

/** Markdown with the HTML pieces the editor writes in it (colours, alignment, tables…) as plain text. */
function plainPiece(s: string): string {
  return decodeEntities(
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\b[^<>]*>/gi, '\n')
      .replace(/<hr\b[^<>]*>/gi, '\n---\n')
      .replace(/<img\b[^<>]*>/gi, (tag) => {
        const alt = attrOf(tag, 'alt').trim();
        return `[picture${alt ? `: ${alt}` : ''}]`;
      })
      .replace(/(<a\b[^<>]*>)([\s\S]*?)<\/a\s*>/gi, (_m, tag: string, inner: string) => {
        const href = attrOf(tag, 'href').trim();
        const text = inner.replace(TAG, '').trim();
        return !/^(https?|mailto):/i.test(href) || !text || text === href || `mailto:${text}` === href ? text || href : `[${text}](${href})`;
      })
      .replace(/<li\b[^<>]*>/gi, '\n- ')
      .replace(/<\/t[dh]\s*>\s*(?=<t[dh]\b)/gi, ' | ')
      .replace(/<\/tr\s*>\s*<tr\b[^<>]*>/gi, '\n')
      .replace(BLOCK, '\n')
      .replace(TAG, ''),
  );
}

/** Fenced code and code spans: written as they are, whatever HTML they show. */
const CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$|(`+)[^`]*?\2/gm;

/**
 * The editor's Markdown as plain text: every HTML tag in it gone (its text kept, `<br>` and the ends of blocks as line
 * breaks, a link as `[text](address)`, a picture as `[picture: alt]`) and entities decoded. Markdown's own marks
 * (`**bold**`, `- ` lists, `> ` quotes) stay: they are how plain text says it. Code is left as written.
 */
export function plainText(md: string): string {
  let out = '';
  let from = 0;
  CODE.lastIndex = 0;
  for (let m; (m = CODE.exec(md)); ) {
    out += plainPiece(md.slice(from, m.index)) + m[0];
    from = m.index + m[0].length;
  }
  return tidyText((out + plainPiece(md.slice(from))).replace(/[ \t]+$/gm, '').replace(/^\n+/, ''));
}

/**
 * The text part from the editor's Markdown, as plain text (plainText): each island's stand-in as islandText has it
 * (the forwarded block or the quote from the original, as a plain-text mail would have them, or the island's own text
 * once edited), pasted pictures as `[picture: name]`.
 */
export function outgoingText(markdown: string, html: string, o: ComposeOriginal | null, tz?: string): string {
  const islands = islandsOf(html);
  // Islands go in after the HTML is taken out: their text is plain already ("Sam <sam@lee.example>" is no tag).
  const texts: string[] = [];
  const md = markdown
    .replace(/^\[\[island:([\w-]+)\]\]$/gm, (_m, ref: string) => {
      const i = islands.get(ref);
      return i ? `\u0000${texts.push(islandText(i, o, tz)) - 1}\u0000` : '';
    })
    .replace(/!\[([^\]]*)\]\(dc-picture:[\w-]+\)/g, (_m, alt: string) => `[picture${alt ? `: ${alt}` : ''}]`);
  // eslint-disable-next-line no-control-regex
  return tidyText(plainText(md).replace(/\u0000(\d+)\u0000/g, (_m, n: string) => texts[Number(n)]));
}
