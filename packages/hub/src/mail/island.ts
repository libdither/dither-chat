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
import type * as P from '@dither-chat/protocol';
import { QUOTE_STYLE } from '@dither-chat/protocol/mail-markdown';
import { attribution, forwardBlock, quoteLines, textHtml, type ComposeOriginal } from './compose.ts';
import { sanitizeCss } from './sanitize.ts';
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
    sheet += `${css}\n`;
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
  const OWN = 'data-dc-own';
  const append = (el: HTMLRewriterTypes.Element, decls: string[]) => {
    if (!decls.length) return;
    const was = el.getAttribute('style') ?? '';
    el.setAttribute('style', `${was}${was && !/;\s*$/.test(was) ? ';' : ''}${decls.join(';')}`);
  };
  let rw = new HTMLRewriter().on('*', {
    element(el) {
      const own = el.getAttribute('style');
      if (own !== null) {
        el.setAttribute(OWN, own);
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
        append(el, [own]);
      }
    },
  });
  for (const r of live) if (r.important.length) rw = rw.on(r.selector, { element: (el) => append(el, r.important) });
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
 * A forward's or a quote's island: the forwarded-message lines or the attribution, then the original's HTML (`content`:
 * sanitised with its sheets and pictures kept, sanitize.ts keepSource), its sheets inlined; or its text when it had no HTML.
 */
export function islandOf(kind: 'forward' | 'quote', o: ComposeOriginal, content: { html: string; body: Record<string, string> } | null, ref: string, tz?: string): P.MailIsland {
  const rootClass = `dc-isl-${ref}`;
  const style = content ? bodyStyle(content.body) : '';
  const wrapped = `<div class="${rootClass}"${style ? ` style="${esc(style)}"` : ''}>${content ? content.html : textHtml((o.text ?? '').replace(/\s+$/, ''))}</div>`;
  // The sheets apply with the wrapper standing in for the original's body.
  const root = content ? inlineCss(wrapped, rootClass) : wrapped;
  const who = o.from.name || o.from.email;
  const when = new Date(o.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(tz ? { timeZone: tz } : {}) });
  if (kind === 'forward') {
    const f = forwardBlock(o, tz);
    return { kind, label: `${who}, ${when}`, html: `<div class="dc-forward-head" style="color:#57606a;margin:0 0 10px">${textHtml(f.head)}</div>${root}` };
  }
  return { kind, label: `${who}, ${when}`, html: `<div class="dc-quote-head">${esc(attribution(o, tz))}</div><blockquote type="cite" style="${QUOTE_STYLE}">${root}</blockquote>` };
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
  /** The account takes inline parts (details.inlineParts); else pictures inside the mail are data: URLs. */
  inlineParts: boolean;
  /** A picture of this hub's (its proxy, an original's cid: part) as the address it stands for, or its bytes. */
  resolve: (src: string) => { url: string } | { cid: { messageId: string; contentId: string } } | null;
  /** A picture's bytes, for embedding: through the hub's image cache. */
  fetchPicture: (url: string) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** An original's inline part's bytes. */
  cidPart: (messageId: string, contentId: string) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** Names the parts made (the same on every try of one send). */
  id: string;
}

interface Outgoing {
  html: string;
  inline: InlinePart[];
  /** What happened to the pictures, for the outbox's log and the tests. */
  linked: number;
  embedded: number;
  dropped: number;
  failed: number;
}

/** Tags the mail never carries, whatever the HTML view held. */
const NEVER = 'script, iframe, object, embed, base, meta, link, form, input, button, select, textarea, frame, frameset, applet, noscript';
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * The editor's HTML as the mail's HTML part: scripts and the editor's own marks gone, pasted pictures as parts (or
 * `data:`), pictures from the web linked, embedded or dropped (`ctx.pictures`), this hub's addresses never leaving it.
 */
export async function outgoingHtml(html: string, ctx: OutgoingCtx): Promise<Outgoing> {
  const out: Outgoing = { html: '', inline: [], linked: 0, embedded: 0, dropped: 0, failed: 0 };
  // First pass: every picture, by what its src is.
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
  const srcs: { src: string; original: string | null }[] = [];
  new HTMLRewriter()
    .on('img', {
      element(el) {
        srcs.push({ src: el.getAttribute('src') ?? '', original: el.getAttribute('data-dc-src') });
      },
    })
    .transform(html);
  // Each distinct picture once: its part, or its data: URL, or its address.
  const made = new Map<string, string | null>();
  const key = (p: Pic) => (p.kind === 'data' ? `d:${p.b64.length}:${p.b64.slice(0, 64)}:${p.b64.slice(-64)}` : p.kind === 'web' ? `w:${p.url}` : p.kind === 'cid' ? `c:${p.messageId}:${p.contentId}` : 'none');
  const part = (bytes: Buffer, mime: string): string => {
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
  await Promise.all(
    [...jobs].map(async ([k, p]) => {
      if (p.kind === 'none') return void made.set(k, null);
      if (p.kind === 'data') return void made.set(k, part(Buffer.from(p.b64, 'base64'), p.mime));
      if (p.kind === 'cid') {
        const got = await ctx.cidPart(p.messageId, p.contentId).catch(() => null);
        if (!got) out.failed++;
        return void made.set(k, got ? part(got.bytes, got.mime) : null);
      }
      if (ctx.pictures === 'drop') return void made.set(k, null);
      if (ctx.pictures === 'link') return void made.set(k, p.url);
      const got = await ctx.fetchPicture(p.url).catch(() => null);
      if (got) return void made.set(k, part(got.bytes, got.mime));
      // Could not be fetched: linked, as it was in the original.
      out.failed++;
      made.set(k, p.url);
    }),
  );
  // Order the parts as they first appear, so the same draft makes the same mail.
  const firstSeen = srcs.map((s) => key(what(s.src, s.original)));
  out.inline.sort((a, b) => firstSeen.findIndex((k) => made.get(k) === `cid:${a.contentId}`) - firstSeen.findIndex((k) => made.get(k) === `cid:${b.contentId}`));

  const counted = new Set<string>();
  // The img handler reads data-dc-src before the * one takes the editor's marks off.
  out.html = new HTMLRewriter()
    .on(NEVER, { element: (el) => void el.remove() })
    .on('img', {
      element(el) {
        const k = key(what(el.getAttribute('src') ?? '', el.getAttribute('data-dc-src')));
        const to = made.get(k) ?? null;
        if (!to) {
          if (!counted.has(k)) out.dropped++;
          counted.add(k);
          return void el.remove();
        }
        if (!counted.has(k)) {
          if (to.startsWith('cid:') || to.startsWith('data:')) out.embedded++;
          else out.linked++;
          counted.add(k);
        }
        el.setAttribute('src', to);
        el.removeAttribute('data-dc-src');
        el.removeAttribute('data-dc-held');
      },
    })
    .on('*', {
      element(el) {
        for (const [n, v] of [...el.attributes]) {
          const name = n.toLowerCase();
          if (name.startsWith('on') || name.startsWith('data-dc-') || name === 'contenteditable') el.removeAttribute(n);
          else if ((name === 'href' || name === 'src' || name === 'action') && /^\s*(javascript|vbscript):/i.test(v)) el.removeAttribute(n);
        }
        const cls = el.getAttribute('class');
        if (cls !== null) {
          const keep = cls.split(/\s+/).filter((c) => c && !/^(dc-quote|dc-folded)$/.test(c));
          if (keep.length) el.setAttribute('class', keep.join(' '));
          else el.removeAttribute('class');
        }
        // Backgrounds from this hub: the address they stand for, or nothing.
        const style = el.getAttribute('style');
        if (style && /url\(/i.test(style)) {
          el.setAttribute(
            'style',
            style.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q, u: string) => {
              const r = ctx.resolve(u);
              if (!r) return /^(https?:|cid:|data:)/i.test(u) ? m : 'none';
              return 'url' in r && ctx.pictures === 'link' ? `url("${r.url}")` : 'none';
            }),
          );
        }
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

/**
 * The text part from the editor's Markdown: each island's stand-in as the forwarded block or the quote in text (from
 * the original, as a plain-text mail would have them), pasted pictures as `[picture: name]`.
 */
export function outgoingText(markdown: string, html: string, o: ComposeOriginal | null, tz?: string): string {
  const islands = islandsOf(html);
  const text = markdown
    .replace(/^\[\[island:([\w-]+)\]\]$/gm, (_m, ref: string) => {
      const i = islands.get(ref);
      if (!i) return '';
      if (i.kind === 'forward' && o) {
        const f = forwardBlock(o, tz);
        return `${f.head}\n\n${f.text}`;
      }
      if (i.kind === 'quote' && o) return `${attribution(o, tz)}\n${quoteLines(o.text)}`;
      return htmlText(i.html);
    })
    .replace(/!\[([^\]]*)\]\(dc-picture:[\w-]+\)/g, (_m, alt: string) => `[picture${alt ? `: ${alt}` : ''}]`)
    .replace(/<span style="color:[^"]*">([\s\S]*?)<\/span>/g, '$1');
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

