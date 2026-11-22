/**
 * The mail editor's document (docs/mail.md "Writing"): one ProseMirror document, which the three views show
 * (MailEditor.tsx). Its parts beyond Tiptap's starter kit:
 *
 * - **Quote**: a blockquote is a mail quote (`<blockquote type="cite">`, with the bar mail apps draw), so a reply's
 *   quote that the document can hold (islandBlocks) is its own text: the attribution, then the original in a quote,
 *   edited like the rest, `> ` in Markdown.
 * - **Island**: HTML the document can't hold as its own blocks (a newsletter's layout, a pasted page), kept exactly as
 *   it came and drawn in a sandboxed frame, so its styles can't reach the page and nothing in it runs. It moves and
 *   goes as one block; its own HTML editor opens under it.
 * - **Picture**: a picture in the text. Pasted or dropped ones are `data:` URLs while you write; the hub sends them as
 *   parts of the mail (cid:) and links to the web stay links (or are fetched in, as the sender chooses).
 * - Colour, alignment, underline and tables, which Markdown can't say, are written into the Markdown view as small
 *   pieces of HTML, so they survive a trip through it.
 *
 * In the Markdown view, islands and pictures stand in as `[[island:id]]` and `dc-picture:id`: the view draws an
 * island as it will arrive and a picture as itself, and the bytes never pass through the text.
 */
import { type Editor, getHTMLFromFragment, getSchema, type JSONContent, type MarkdownRendererHelpers, mergeAttributes, Node } from '@tiptap/core';
import Heading from '@tiptap/extension-heading';
import Image from '@tiptap/extension-image';
import Paragraph from '@tiptap/extension-paragraph';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Markdown } from '@tiptap/markdown';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';

/** A random id for an island or a picture, unique enough within one draft. */
export const newRef = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------- pictures from the web, never fetched

/**
 * A picture address your browser would fetch from the web itself (not this hub's, not pasted bytes). The editor never
 * fetches one: that would tell its host, from your address, that you are writing (docs/mail.md "Writing").
 */
const fromWeb = (src: string) => /^\s*(https?:)?\/\//i.test(src);
const hostOf = (src: string) => {
  try {
    return new URL(src, 'https://x.invalid').host;
  } catch {
    return 'the web';
  }
};
const webBoxTitle = (src: string) => `A picture from ${hostOf(src)}: not fetched while you write; it goes as the pictures choice says`;
const px = (v: unknown) => {
  const n = parseFloat(String(v ?? ''));
  return n > 0 && n < 5000 ? Math.round(n) : null;
};
/** A box's size from the picture's own width and height: its shape kept, never wider than the page. */
function boxSize(w: unknown, h: unknown): string {
  const W = px(w);
  const H = px(h);
  return `max-width:100%;${W && H ? `width:${W}px;aspect-ratio:${W}/${H}` : W ? `width:${W}px;height:${Math.min(W, 64)}px` : H ? `width:${Math.min(H, 96)}px;height:${H}px` : 'width:96px;height:64px'}`;
}

/** Each editor's addresses that will not go (MailEditor's leftOut). */
const leftOutOf = new WeakMap<Element, Set<string>>();

/** Marks one picture or box: faded and dashed, "left out" said on it, when its address will not go. */
function markOne(el: Element, out: Set<string> | undefined) {
  const raw = el.getAttribute('data-dc-src') ?? el.getAttribute('data-dc-was');
  // An address without its scheme goes over https, and the left-out list says so.
  const u = raw && /^\s*\/\//.test(raw) ? `https:${raw.trim()}` : raw;
  const gone = !!u && !!out?.has(u);
  if (gone === el.classList.contains('dc-out')) return;
  el.classList.toggle('dc-out', gone);
  if (gone) el.setAttribute('data-dc-title', el.getAttribute('title') ?? '');
  const was = el.getAttribute('data-dc-title');
  if (gone) el.setAttribute('title', 'Left out when it is sent');
  else if (was !== null) {
    if (was) el.setAttribute('title', was);
    else el.removeAttribute('title');
    el.removeAttribute('data-dc-title');
  }
}
const markInEditor = (el: Element) => {
  const root = el.closest('.me');
  if (root) markOne(el, leftOutOf.get(root));
};

/**
 * How the editor draws a picture address from the web: a striped box the picture's shape, its host written on it, never
 * fetched (marked when it will not go); null for any other address.
 */
export function webBox(src: string, w?: unknown, h?: unknown): HTMLElement | null {
  if (!fromWeb(src)) return null;
  const s = document.createElement('span');
  s.className = 'me-pic-web';
  s.contentEditable = 'false';
  s.setAttribute('data-dc-was', src);
  s.setAttribute('style', boxSize(w, h));
  s.title = webBoxTitle(src);
  s.textContent = hostOf(src);
  // Marked once it is in the editor (a node view and a widget are made before they are placed).
  requestAnimationFrame(() => markInEditor(s));
  return s;
}

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The island's HTML with its pictures from the web as boxes (the original kept in data-dc-was), and the other choices
 * a browser has (srcset, <picture>'s sources), which the frame would refuse, taken out.
 */
function boxed(html: string): string {
  if (!/<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\/|\bsrcset\s*=|<source\b|\bdata-dc-held\b/i.test(html)) return html;
  const d = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  d.querySelectorAll('picture source, img[srcset]').forEach((x) => (x.tagName === 'SOURCE' ? x.remove() : x.removeAttribute('srcset')));
  // A held one is a striped picture of its own shape: the picture's, when it says its size; else not too tall.
  for (const img of d.querySelectorAll<HTMLImageElement>('img[data-dc-held]')) {
    const W = px(img.getAttribute('width'));
    const H = px(img.getAttribute('height'));
    if (W && H) img.style.aspectRatio = `${W}/${H}`;
    else img.style.maxHeight = '120px';
  }
  for (const img of d.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!fromWeb(src)) continue;
    const box = d.createElement('span');
    box.className = 'dc-web';
    box.setAttribute('data-dc-was', src);
    box.setAttribute('role', 'img');
    box.setAttribute('title', webBoxTitle(src));
    box.setAttribute('style', boxSize(img.getAttribute('width'), img.getAttribute('height')));
    box.innerHTML = escapeText(hostOf(src));
    img.replaceWith(box);
  }
  return d.body.innerHTML;
}

/**
 * The frame an island is drawn in: a white sheet, its own styles, nothing that runs, and no picture but this hub's and
 * pasted ones (one from the web is a striped box). Pictures that will not go as the mail is sent are faded and dashed;
 * a held one (already a striped box) keeps its strength, so its dashes show.
 */
export function islandDoc(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'\">" +
    '<style>html,body{margin:0;background:#fff;color:#1f2328;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow:hidden}' +
    'body{padding:8px 10px}img{max-width:100%;height:auto}a{color:#0b62d6}blockquote[type=cite]{margin:0 0 0 2px;padding-left:10px;border-left:2px solid #c9d1d9;color:#57606a}' +
    '.dc-web{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden;vertical-align:middle;padding:2px 4px;' +
    'background:repeating-linear-gradient(45deg,#eef0f2 0 6px,#f8f9fa 6px 12px);border:1px dashed #afb8c1;color:#57606a;font-size:11px;line-height:1.2;text-align:center;word-break:break-all}' +
    '.dc-out{opacity:.35;outline:2px dashed #cf222e;outline-offset:-2px}img.dc-out[data-dc-held]{opacity:1}' +
    '.dc-web.dc-out{opacity:1;color:#cf222e}.dc-web.dc-out::after{content:"left out"}</style></head>' +
    `<body>${boxed(html)}</body></html>`
  );
}

/** Marks the frame's pictures that will not go, as its editor has them. */
function markLeftOut(f: HTMLIFrameElement) {
  const doc = f.contentDocument;
  if (!doc?.body) return;
  const out = leftOutOf.get(f.closest('.me') ?? f);
  doc.querySelectorAll('[data-dc-src], [data-dc-was]').forEach((el) => markOne(el, out));
}

/** The editor at `root`: these addresses will not go; its frames and its boxes mark them. */
export function setLeftOut(root: Element, urls: string[]) {
  const out = new Set(urls);
  leftOutOf.set(root, out);
  root.querySelectorAll<HTMLIFrameElement>('iframe.me-island-frame').forEach(markLeftOut);
  root.querySelectorAll('.me-pic-web[data-dc-was], .me-rich-doc img[data-dc-src]').forEach((el) => markOne(el, out));
}

/** Sizes a frame to its content, and again when its pictures arrive; returns how to stop. */
export function fitFrame(f: HTMLIFrameElement): () => void {
  let ro: ResizeObserver | null = null;
  const fit = () => {
    const doc = f.contentDocument;
    if (!doc?.body) return;
    const W = f.clientWidth;
    const wrap = doc.body;
    wrap.style.transform = '';
    wrap.style.width = '';
    wrap.style.boxSizing = '';
    // The body's margins stay unscaled around it, so the scaled body gets what is left between them.
    const cs = doc.defaultView!.getComputedStyle(wrap);
    const margins = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
    const natural = Math.max(wrap.scrollWidth, doc.documentElement.scrollWidth - margins);
    let k = 1;
    if (W && natural + margins > W + 1) {
      k = (W - margins) / natural;
      // scrollWidth counts the body's padding: the width set must too.
      wrap.style.boxSizing = 'border-box';
      wrap.style.width = `${natural}px`;
      wrap.style.transformOrigin = '0 0';
      wrap.style.transform = `scale(${k})`;
    }
    f.style.height = `${Math.max(24, Math.ceil(wrap.offsetHeight * k))}px`;
  };
  const loaded = () => {
    markLeftOut(f);
    fit();
    const doc = f.contentDocument;
    if (!doc) return;
    doc.addEventListener('load', fit, true);
    ro?.disconnect();
    ro = new ResizeObserver(fit);
    ro.observe(f);
    // Never followed inside the editor.
    doc.addEventListener('click', (e) => e.target instanceof doc.defaultView!.Element && e.target.closest('a') && e.preventDefault(), true);
  };
  f.addEventListener('load', loaded);
  if (f.contentDocument?.readyState === 'complete') loaded();
  return () => {
    f.removeEventListener('load', loaded);
    ro?.disconnect();
  };
}

const KIND_LABEL: Record<string, string> = { forward: 'Forwarded message', quote: 'Quoted text', html: 'HTML' };

/** An island's "Edit HTML": its own HTML editor opens in `host`, under it (MailEditor mounts it); `set` takes the edits. */
export interface IslandEdit {
  host: HTMLElement;
  html: string;
  set: (html: string) => void;
  /** It closed (Done, or the island went). */
  closed: () => void;
}

export interface IslandAttrs {
  /** forward | quote | html (pasted or written in the HTML view). */
  kind: string;
  html: string;
  /** A line about it, shown on its bar ("From Sam Lee, Tue 10:42"). */
  label: string;
  /** The message it came from (forward or quote). */
  from: string | null;
  ref: string;
}

const Island = Node.create({
  name: 'island',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      kind: { default: 'html' },
      html: { default: '' },
      label: { default: '' },
      from: { default: null },
      ref: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-dc-island]',
        // The HTML inside is the island's, not the document's.
        getAttrs: (el) => {
          const e = el as HTMLElement;
          return { kind: e.getAttribute('data-dc-island') || 'html', html: e.innerHTML, label: e.getAttribute('data-dc-label') ?? '', from: e.getAttribute('data-dc-from'), ref: newRef() };
        },
      },
    ];
  },
  // The HTML inside is put back by islandsIn() after serialising: renderHTML can only make elements.
  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-dc-island': node.attrs.kind, 'data-dc-label': node.attrs.label || null, 'data-dc-from': node.attrs.from || null, 'data-dc-ref': node.attrs.ref })];
  },
  renderMarkdown: (node: { attrs?: { ref?: string } }) => `[[island:${node.attrs?.ref ?? ''}]]`,
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement('div');
      dom.className = 'me-island';
      dom.contentEditable = 'false';
      dom.dataset.kind = node.attrs.kind;
      const bar = document.createElement('div');
      bar.className = 'me-island-bar';
      const name = document.createElement('span');
      name.className = 'me-island-name';
      const naming = (n: PMNode) => {
        const size = new Blob([n.attrs.html]).size;
        name.textContent = `${KIND_LABEL[n.attrs.kind] ?? 'HTML'}${n.attrs.label ? ` · ${n.attrs.label}` : ''} · its own HTML, sent as it is · ${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}`;
      };
      naming(node);
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.className = 'me-island-btn';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'me-island-btn';
      remove.textContent = '✕';
      remove.title = 'Take it out of the message';
      remove.setAttribute('aria-label', remove.title);
      remove.onclick = () => {
        const at = typeof getPos === 'function' ? getPos() : null;
        if (at != null) editor.chain().focus().deleteRange({ from: at, to: at + node.nodeSize }).run();
      };
      bar.append(name, fold);
      // Its own HTML, edited in place: an HTML editor opens under it, and it is drawn again as you type.
      const codeHost = document.createElement('div');
      codeHost.className = 'me-island-code';
      codeHost.hidden = true;
      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'me-island-btn';
      code.textContent = 'Edit HTML';
      code.title = 'Edit its HTML here, under it';
      let editing = false;
      let gone = false;
      const closed = () => {
        editing = false;
        codeHost.hidden = true;
        code.textContent = 'Edit HTML';
        code.setAttribute('aria-expanded', 'false');
      };
      code.onclick = () => {
        if (editing) {
          codeHost.dispatchEvent(new CustomEvent('me-island-done'));
          return;
        }
        editing = true;
        codeHost.hidden = false;
        code.textContent = 'Done';
        code.setAttribute('aria-expanded', 'true');
        const detail: IslandEdit = {
          host: codeHost,
          html: node.attrs.html,
          set: (html) => {
            if (gone || html === node.attrs.html) return;
            const at = typeof getPos === 'function' ? getPos() : null;
            if (at != null) editor.view.dispatch(editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, html }));
          },
          closed,
        };
        dom.dispatchEvent(new CustomEvent('me-edit-island', { bubbles: true, detail }));
      };
      bar.append(code, remove);
      const sheet = document.createElement('div');
      sheet.className = 'me-island-sheet';
      const frame = document.createElement('iframe');
      frame.className = 'me-island-frame';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = KIND_LABEL[node.attrs.kind] ?? 'HTML';
      // Open: what goes is in sight.
      let open = true;
      const show = () => {
        sheet.hidden = !open;
        fold.textContent = open ? 'Hide' : 'Show';
        fold.setAttribute('aria-expanded', String(open));
        if (open && !frame.srcdoc) frame.srcdoc = islandDoc(node.attrs.html);
      };
      fold.onclick = () => {
        open = !open;
        show();
      };
      sheet.append(frame);
      // The HTML editor right under the bar: in sight above a long forward, which redraws below it as you type.
      dom.append(bar, codeHost, sheet);
      const stop = fitFrame(frame);
      show();
      return {
        dom,
        // Its edit drawn again in place (the HTML editor under it stays open).
        update: (n) => {
          if (n.type !== node.type || n.attrs.kind !== node.attrs.kind) return false;
          const changed = n.attrs.html !== node.attrs.html;
          node = n;
          if (changed) {
            naming(n);
            if (frame.srcdoc) frame.srcdoc = islandDoc(n.attrs.html);
          }
          return true;
        },
        stopEvent: (e) => !!(e.target as Element | null)?.closest?.('.me-island-btn, .me-island-code'),
        ignoreMutation: () => true,
        destroy: () => {
          gone = true;
          stop();
          if (editing) codeHost.dispatchEvent(new CustomEvent('me-island-done'));
        },
      };
    };
  },
});

/** A picture: `src` a data: URL (pasted, dropped) or a web address; `ref` names it in the Markdown view. */
const Picture = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ref: { default: null, rendered: false },
      width: { default: null },
      height: { default: null },
      // A picture from an original (a quote's, a forward's): its address on the web, and why the reader held it.
      dcSrc: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-dc-src'), renderHTML: (a: { dcSrc?: string | null }) => (a.dcSrc ? { 'data-dc-src': a.dcSrc } : {}) },
      dcHeld: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute('data-dc-held'), renderHTML: (a: { dcHeld?: string | null }) => (a.dcHeld ? { 'data-dc-held': a.dcHeld } : {}) },
    };
  },
  renderMarkdown: (node: { attrs?: { src?: string; alt?: string; ref?: string } }) => {
    const src = node.attrs?.src ?? '';
    const alt = (node.attrs?.alt ?? '').replace(/[[\]]/g, '');
    // Bytes and this hub's addresses stay out of the text: the view draws the picture from the id.
    return fromWeb(src) ? `![${alt}](${src})` : `![${alt}](dc-picture:${node.attrs?.ref ?? ''})`;
  },
  // Drawn as it is, but one from the web as a striped box: the editor fetches nothing from the web.
  addNodeView() {
    return ({ node }) => {
      const src = String(node.attrs.src ?? '');
      const box = webBox(src, node.attrs.width, node.attrs.height);
      let dom: HTMLElement;
      if (box) dom = box;
      else {
        const img = document.createElement('img');
        img.src = src;
        img.alt = node.attrs.alt ?? '';
        if (node.attrs.title) img.title = node.attrs.title;
        for (const k of ['width', 'height'] as const) if (node.attrs[k] != null) img.setAttribute(k, String(node.attrs[k]));
        if (node.attrs.dcSrc) {
          img.setAttribute('data-dc-src', node.attrs.dcSrc);
          requestAnimationFrame(() => markInEditor(img));
        }
        // A held one is a striped picture of the original's shape (else it would be a big square).
        if (node.attrs.dcHeld) {
          img.setAttribute('data-dc-held', node.attrs.dcHeld);
          const W = px(node.attrs.width);
          const H = px(node.attrs.height);
          if (W && H) img.style.aspectRatio = `${W}/${H}`;
          else img.style.maxHeight = '120px';
        }
        dom = img;
      }
      // Any change draws it again.
      const same = (n: PMNode) => ['src', 'width', 'height', 'alt', 'title', 'dcSrc', 'dcHeld'].every((k) => n.attrs[k] === node.attrs[k]);
      return { dom, update: (n) => n.type === node.type && same(n) };
    };
  },
}).configure({ inline: true, allowBase64: true });

/** Colour (TextStyle) written into Markdown as a span, which comes back as colour. */
const ColorStyle = TextStyle.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers) => {
    const c = node.attrs?.color as string | undefined;
    const inner = h.renderChildren(node);
    return c ? `<span style="color:${c}">${inner}</span>` : inner;
  },
});

/**
 * A centred or right-aligned paragraph or heading, which Markdown can't say, written into Markdown as its HTML (pasted
 * pictures as their stand-ins), which comes back aligned; others as Markdown.
 */
let alignSchema: Schema | null = null;
function alignedHtml(node: JSONContent): string | null {
  const align = node.attrs?.textAlign as string | undefined;
  if (!align || align === 'left' || !node.content?.length) return null;
  alignSchema ??= getSchema(extensions(''));
  const stand = (n: JSONContent): JSONContent =>
    n.type === 'image' && String(n.attrs?.src ?? '').startsWith('data:') ? { ...n, attrs: { ...n.attrs, src: `dc-picture:${n.attrs?.ref ?? ''}` } } : n;
  const inner = getHTMLFromFragment(PMNode.fromJSON(alignSchema, { ...node, content: node.content.map(stand) }).content, alignSchema);
  const tag = node.type === 'heading' ? `h${node.attrs?.level ?? 1}` : 'p';
  return `<${tag} style="text-align: ${align}">${inner}</${tag}>`;
}
const AlignedParagraph = Paragraph.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers, ctx: unknown) => alignedHtml(node) ?? Paragraph.config.renderMarkdown!.call(null as never, node as never, h, ctx as never),
});
const AlignedHeading = Heading.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers, ctx: unknown) => alignedHtml(node) ?? Heading.config.renderMarkdown!.call(null as never, node as never, h, ctx as never),
}).configure({ levels: [1, 2, 3] });

/** Every extension the document uses. */
export function extensions(placeholder: string) {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: null } },
      paragraph: false,
      heading: false,
      // A quote as mail apps write one (and as the hub writes Markdown's `>`: protocol mail-markdown QUOTE_STYLE).
      blockquote: { HTMLAttributes: { type: 'cite', style: 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex' } },
    }),
    AlignedParagraph,
    AlignedHeading,
    ColorStyle,
    Color,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Picture,
    Table.configure({ resizable: false, HTMLAttributes: { style: 'border-collapse:collapse;margin:0 0 1em' } }),
    TableRow,
    TableHeader.configure({ HTMLAttributes: { style: 'border:1px solid #bbb;padding:4px 8px;text-align:left' } }),
    TableCell.configure({ HTMLAttributes: { style: 'border:1px solid #bbb;padding:4px 8px' } }),
    Island,
    Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
    Placeholder.configure({ placeholder }),
  ];
}

// ------------------------------------------------------------------ the document in and out

/** The islands and pictures of a document, by ref (each given one when missing), for the Markdown view. */
export function refsOf(editor: Editor): { islands: Map<string, IslandAttrs>; pictures: Map<string, string>; attrs: Map<string, Record<string, unknown>> } {
  const islands = new Map<string, IslandAttrs>();
  const pictures = new Map<string, string>();
  // A picture's other attributes (its size, an original's address), which Markdown can't say: put back from here.
  const attrs = new Map<string, Record<string, unknown>>();
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((n: PMNode, pos: number) => {
    if (n.type.name !== 'island' && n.type.name !== 'image') return;
    let ref = n.attrs.ref as string | null;
    if (!ref) {
      ref = newRef();
      tr.setNodeMarkup(pos, undefined, { ...n.attrs, ref });
      changed = true;
    }
    if (n.type.name === 'island') islands.set(ref, { ...(n.attrs as IslandAttrs), ref });
    else if (!fromWeb(String(n.attrs.src ?? ''))) {
      pictures.set(ref, n.attrs.src);
      attrs.set(ref, { ...n.attrs, ref });
    }
  });
  if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false));
  return { islands, pictures, attrs };
}

/** The document as the mail's HTML: islands filled in with their own HTML. */
export function docHtml(editor: Editor): string {
  const islands: string[] = [];
  editor.state.doc.descendants((n: PMNode) => {
    if (n.type.name === 'island') islands.push(n.attrs.html as string);
  });
  let i = 0;
  return editor.getHTML().replace(/<div data-dc-island="[^"]*"[^>]*><\/div>/g, (m) => m.replace('></div>', `>${islands[i++] ?? ''}</div>`));
}

/** Markdown of the document, with islands and pasted pictures as their stand-ins. */
export function docMarkdown(editor: Editor): string {
  refsOf(editor);
  return editor.getMarkdown();
}
