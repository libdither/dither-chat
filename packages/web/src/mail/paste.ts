/**
 * Rich text pasted into the composer (a web page, a document, another mail) kept as Markdown, the composer's own
 * formatting (docs/mail.md, "Formatting"): bold, italic, struck-through text, code, links, headings, lists and quotes.
 * Colours, fonts, sizes, pictures and tables' lines are left behind. Works on any DOM-like tree, so the test runs
 * without a browser; the composer hands it DOMParser's body, an inert document (nothing in it loads or runs).
 */

/** What is read of a node: the DOM's own names. */
export interface PasteNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<PasteNode>;
  getAttribute?(name: string): string | null;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'svg', 'SVG', 'IFRAME', 'OBJECT']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'DL', 'DT', 'DD', 'ADDRESS', 'CENTER']);
const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

const styleOf = (n: PasteNode) => (n.getAttribute?.('style') ?? '').toLowerCase();
const weight = (s: string) => s.match(/font-weight\s*:\s*([a-z0-9]+)/)?.[1];

/** Bold, italic or struck, from the tag or its style (a span in a document; Google Docs' outer `<b>` that is not). */
function marksOf(n: PasteNode): { bold: boolean; italic: boolean; strike: boolean } {
  const tag = n.nodeName.toUpperCase();
  const st = styleOf(n);
  const w = weight(st);
  const heavy = w === 'bold' || w === 'bolder' || (!!w && Number(w) >= 600);
  const light = w === 'normal' || w === 'lighter' || (!!w && Number(w) < 600);
  return {
    bold: ((tag === 'B' || tag === 'STRONG') && !light) || heavy,
    italic: tag === 'I' || tag === 'EM' || /font-style\s*:\s*italic/.test(st),
    strike: tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || /text-decoration[a-z-]*\s*:[^;]*line-through/.test(st),
  };
}

/** Marks around inline text, with the spaces kept outside them (Markdown's marks hold none inside). */
function around(inner: string, m: string): string {
  const body = inner.trim();
  if (!body || body.includes('\n\n')) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const tail = inner.slice(inner.trimEnd().length);
  return `${lead}${m}${body}${m}${tail}`;
}

function textOf(n: PasteNode): string {
  if (n.nodeType === 3) return n.nodeValue ?? '';
  let s = '';
  for (let i = 0; i < n.childNodes.length; i++) s += textOf(n.childNodes[i]);
  return s;
}

function inline(n: PasteNode, depth: number): string {
  if (n.nodeType === 3) return (n.nodeValue ?? '').replace(/\s+/g, ' ');
  if (n.nodeType !== 1) return '';
  const tag = n.nodeName.toUpperCase();
  if (SKIP.has(tag)) return '';
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') return n.getAttribute?.('alt') ?? '';
  if (tag === 'PRE') return `\n\n\`\`\`\n${textOf(n).replace(/\n$/, '')}\n\`\`\`\n\n`;
  if (tag === 'CODE') {
    const t = textOf(n);
    return t.includes('`') ? t : around(t, '`');
  }
  if (/^H[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${kids(n, depth).replace(/\s*\n\s*/g, ' ').trim()}\n\n`;
  if (tag === 'UL' || tag === 'OL') return `\n\n${list(n, depth)}\n\n`;
  if (tag === 'BLOCKQUOTE') {
    const body = tidy(kids(n, depth));
    return body ? `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
  }
  if (tag === 'HR') return '\n\n---\n\n';
  let out = kids(n, depth);
  if (tag === 'A') {
    const href = (n.getAttribute?.('href') ?? '').trim();
    const t = out.trim();
    if (SAFE_HREF.test(href) && t) out = t === href || `mailto:${t}` === href ? href : `[${t.replace(/[[\]]/g, '\\$&')}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
  }
  const mk = marksOf(n);
  if (mk.strike) out = around(out, '~~');
  if (mk.italic) out = around(out, '_');
  if (mk.bold) out = around(out, '**');
  if (tag === 'LI' || tag === 'TD' || tag === 'TH') return out;
  if (tag === 'P') return `\n\n${out}\n\n`;
  if (BLOCK.has(tag)) return `\n${out}\n`;
  return out;
}

function kids(n: PasteNode, depth: number): string {
  let s = '';
  for (let i = 0; i < n.childNodes.length; i++) {
    const c = n.childNodes[i];
    s += inline(c, depth);
    if (c.nodeType === 1 && /^T[DH]$/.test(c.nodeName.toUpperCase())) s += ' ';
  }
  return s;
}

function list(n: PasteNode, depth: number): string {
  const ordered = n.nodeName.toUpperCase() === 'OL';
  const pad = '   '.repeat(depth);
  const out: string[] = [];
  let k = Number(n.getAttribute?.('start')) || 1;
  for (let i = 0; i < n.childNodes.length; i++) {
    const c = n.childNodes[i];
    if (c.nodeType !== 1 || c.nodeName.toUpperCase() !== 'LI') continue;
    // The item's own text, then any list inside it, one level in.
    let own = '';
    const sub: string[] = [];
    for (let j = 0; j < c.childNodes.length; j++) {
      const g = c.childNodes[j];
      const t = g.nodeType === 1 ? g.nodeName.toUpperCase() : '';
      if (t === 'UL' || t === 'OL') sub.push(list(g, depth + 1));
      else own += inline(g, depth);
    }
    const marker = ordered ? `${k++}. ` : '- ';
    out.push(`${pad}${marker}${tidy(own).replace(/\n+/g, ' ')}`, ...sub);
  }
  return out.join('\n');
}

/** Spaces at the ends of lines, and more than one blank line, go. */
function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, '').replace(/^ +(?=[^ \-\d*>#])/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The Markdown a pasted HTML tree reads as. Null when it has nothing Markdown would keep (no link, mark, heading,
 * list, quote or code): the paste then goes in as the clipboard's text, as it always did.
 */
export function pastedMarkdown(body: PasteNode): string | null {
  const md = tidy(kids(body, 0));
  if (!md) return null;
  return /\*\*|(^|\W)_\S|~~|`|\]\(|^#{1,6} |^\s*(- |\d+\. |> )/m.test(md) ? md : null;
}
