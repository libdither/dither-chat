/**
 * Just enough HTML parsing for exporter output: a fragment becomes a small tree of elements and text, attributes
 * quoted or not, entities decoded. Exports are read a fragment at a time (one message group), never as a whole
 * document, so a 134 MB file never becomes one tree.
 */

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: El | null;
}
export type Node = El | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<!(?:[^>]*)>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function parseFragment(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(html))) {
    const [all, close, open, attrText, selfClose] = m;
    if (all.startsWith('<!')) continue;
    if (close) {
      const tag = close.toLowerCase();
      // Close the nearest open element of that name; a stray close tag is ignored.
      for (let e: El | null = cur; e && e !== root; e = e.parent) {
        if (e.tag === tag) {
          cur = e.parent!;
          break;
        }
      }
      continue;
    }
    if (open) {
      const tag = open.toLowerCase();
      const attrs: Record<string, string> = {};
      ATTR.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = ATTR.exec(attrText ?? ''))) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      const el: El = { tag, attrs, children: [], parent: cur };
      cur.children.push(el);
      if (RAW.has(tag)) {
        // Skip to the end of a script or style.
        const end = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
        TOKEN.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
        continue;
      }
      if (!VOID.has(tag) && !selfClose) cur = el;
      continue;
    }
    cur.children.push(decodeEntities(all));
  }
  return root;
}

export const classes = (e: El): string[] => (e.attrs.class ?? '').split(/\s+/).filter(Boolean);
export const hasClass = (e: El, c: string) => classes(e).includes(c);

export function* walk(e: El): Generator<El> {
  for (const c of e.children) {
    if (typeof c === 'string') continue;
    yield c;
    yield* walk(c);
  }
}

/** The first descendant with this class. */
export function find(e: El, cls: string): El | null {
  for (const x of walk(e)) if (hasClass(x, cls)) return x;
  return null;
}
export function findAll(e: El, cls: string): El[] {
  const out: El[] = [];
  for (const x of walk(e)) if (hasClass(x, cls)) out.push(x);
  return out;
}

/** Descendants with this class that are not inside another element with `stop` (a nested message, an embed). */
export function findOwn(e: El, cls: string, stop: string[]): El[] {
  const out: El[] = [];
  const visit = (n: El) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (hasClass(c, cls)) out.push(c);
      if (!stop.some((s) => hasClass(c, s))) visit(c);
    }
  };
  visit(e);
  return out;
}

export function text(e: Node): string {
  if (typeof e === 'string') return e;
  if (e.tag === 'br') return '\n';
  return e.children.map(text).join('');
}
