/**
 * Rich text pasted into the composer (a web page, a document, another mail) kept as Markdown, the composer's own
 * formatting (docs/mail.md, "Formatting"): bold, italic, struck-through text, code, links, headings, lists, quotes and
 * tables of data. Colours, fonts, sizes, pictures and layout tables are left behind (a picture pasted on its own is attached: see
 * pastedFiles). Works on any DOM-like tree, so the test runs without a browser; the composer hands it DOMParser's body,
 * an inert document (nothing in it loads or runs).
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
  if (tag === 'TABLE') {
    const t = gridOf(n, depth);
    if (t) return `\n\n${t}\n\n`;
  }
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

const elems = (n: PasteNode) => Array.from(n.childNodes as ArrayLike<PasteNode>).filter((c) => c.nodeType === 1);
const tagOf = (n: PasteNode) => n.nodeName.toUpperCase();

/**
 * A table of data (a spreadsheet's cells, a page's table) as GitHub's Markdown table, its first row the header. Null
 * for one that is layout (a single row or column, a table inside, cells spanning others): its text then goes in as
 * lines, as before.
 */
function gridOf(n: PasteNode, depth: number): string | null {
  const rows: PasteNode[] = [];
  for (const c of elems(n)) {
    const t = tagOf(c);
    if (t === 'TR') rows.push(c);
    else if (t === 'THEAD' || t === 'TBODY' || t === 'TFOOT') rows.push(...elems(c).filter((r) => tagOf(r) === 'TR'));
  }
  const cells = rows.map((r) => elems(r).filter((c) => /^T[DH]$/.test(tagOf(c))));
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (rows.length < 2 || width < 2) return null;
  const spans = (c: PasteNode) => Number(c.getAttribute?.('colspan') || 1) > 1 || Number(c.getAttribute?.('rowspan') || 1) > 1;
  const nested = (c: PasteNode): boolean => elems(c).some((k) => tagOf(k) === 'TABLE' || nested(k));
  if (cells.some((r) => r.some((c) => spans(c) || nested(c)))) return null;
  const text = (c: PasteNode) => tidy(kids(c, depth)).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|') || ' ';
  const line = (r: PasteNode[]) => `| ${Array.from({ length: width }, (_, i) => (r[i] ? text(r[i]) : ' ')).join(' | ')} |`;
  return [line(cells[0]), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(line)].join('\n');
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
  return /\*\*|(^|\W)_\S|~~|`|\]\(|^#{1,6} |^\s*(- |\d+\. |> )|^\|.*\|$/m.test(md) ? md : null;
}

// ------------------------------------------------------------------ pictures and files

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/heic': 'heic' };
/** The names browsers give a picture with no file behind it (a screenshot, "Copy image"). */
const GENERIC = /^(image|unknown|blob|clipboard)?(\.[a-z0-9]+)?$/i;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * What a paste attaches: the clipboard's files when it holds no text, else null and the paste is text. (A document's
 * copy carries a picture of the selection beside its text: the text is what was meant.) A picture with no name of its
 * own gets "Pasted picture <date> <time>.png", numbered when there are more.
 */
export function pastedFiles(files: File[], plain: string, now = new Date()): File[] | null {
  if (!files.length || plain.trim()) return null;
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
  const unnamed = files.filter((f) => GENERIC.test(f.name)).length;
  let k = 0;
  return files.map((f) => {
    if (!GENERIC.test(f.name)) return f;
    const ext = EXT[f.type] ?? f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png';
    const what = f.type.startsWith('image/') || !f.type ? 'picture' : 'file';
    const name = `Pasted ${what} ${stamp}${unnamed > 1 ? ` (${++k})` : ''}.${ext}`;
    return new File([f], name, { type: f.type || 'image/png', lastModified: f.lastModified });
  });
}
