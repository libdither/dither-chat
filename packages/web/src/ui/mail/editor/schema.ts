/**
 * The mail editor's document (docs/mail.md "Writing"): one ProseMirror document, which the three views show
 * (MailEditor.tsx). Its parts beyond Tiptap's starter kit:
 *
 * - **Island**: HTML the document can't hold as its own blocks (a forwarded mail, a quote, a pasted layout), kept
 *   exactly as it came and drawn in a sandboxed frame, so its styles can't reach the page and nothing in it runs. It
 *   moves and goes as one block; the HTML view edits it.
 * - **Picture**: a picture in the text. Pasted or dropped ones are `data:` URLs while you write; the hub sends them as
 *   parts of the mail (cid:) and links to the web stay links (or are fetched in, as the sender chooses).
 * - Colour, alignment, underline and tables, which Markdown can't say, are written into the Markdown view as small
 *   pieces of HTML, so they survive a trip through it.
 *
 * In the Markdown view, islands and pictures stand in as `[[island:id]]` and `dc-picture:id`: the view shows them as
 * chips, and the bytes never pass through the text.
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
/** What stands for one while you write: an empty picture, drawn as a striped box. */
const WEB_BOX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const hostOf = (src: string) => {
  try {
    return new URL(src, 'https://x.invalid').host;
  } catch {
    return 'the web';
  }
};
const webBoxTitle = (src: string) => `A picture from ${hostOf(src)}: not fetched while you write; it goes as the pictures choice says`;
/** How the editor draws a picture address: one from the web as a box with its host, never fetched; else null. */
export const webBox = (src: string) => (fromWeb(src) ? { src: WEB_BOX, title: webBoxTitle(src) } : null);

/** The island's HTML with its pictures from the web as boxes (the original kept in data-dc-was). */
function boxed(html: string): string {
  if (!/<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) return html;
  const d = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  for (const img of d.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!fromWeb(src)) continue;
    img.setAttribute('src', WEB_BOX);
    img.setAttribute('data-dc-was', src);
    img.classList.add('dc-web');
    img.setAttribute('title', webBoxTitle(src));
  }
  return d.body.innerHTML;
}

/**
 * The frame an island is drawn in: a white sheet, its own styles, nothing that runs, and no picture but this hub's and
 * pasted ones (one from the web is a striped box). Pictures that will not go as the mail is sent are faded and dashed.
 */
export function islandDoc(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'\">" +
    '<style>html,body{margin:0;background:#fff;color:#1f2328;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow:hidden}' +
    'body{padding:8px 10px}img{max-width:100%;height:auto}a{color:#0b62d6}blockquote[type=cite]{margin:0 0 0 2px;padding-left:10px;border-left:2px solid #c9d1d9;color:#57606a}' +
    'img.dc-web{min-width:48px;min-height:32px;background:repeating-linear-gradient(45deg,#eef0f2 0 6px,#f8f9fa 6px 12px);outline:1px dashed #afb8c1;outline-offset:-1px}' +
    'img.dc-out{opacity:.25;outline:2px dashed #cf222e;outline-offset:-2px}</style></head>' +
    `<body>${boxed(html)}</body></html>`
  );
}

/** Each editor's addresses that will not go (MailEditor's leftOut), for its frames. */
const leftOutOf = new WeakMap<Element, Set<string>>();

/** Marks the frame's pictures that will not go, as its editor has them. */
function markLeftOut(f: HTMLIFrameElement) {
  const doc = f.contentDocument;
  const out = leftOutOf.get(f.closest('.me') ?? f);
  if (!doc?.body) return;
  for (const img of doc.querySelectorAll('img')) {
    const u = img.getAttribute('data-dc-src') ?? img.getAttribute('data-dc-was');
    const gone = !!u && !!out?.has(u);
    if (gone === img.classList.contains('dc-out')) continue;
    img.classList.toggle('dc-out', gone);
    if (gone) img.setAttribute('data-dc-title', img.getAttribute('title') ?? '');
    const was = img.getAttribute('data-dc-title');
    if (gone) img.setAttribute('title', 'Left out when it is sent');
    else if (was !== null) {
      if (was) img.setAttribute('title', was);
      else img.removeAttribute('title');
      img.removeAttribute('data-dc-title');
    }
  }
}

/** The editor at `root`: these addresses will not go; its frames mark them. */
export function setLeftOut(root: Element, urls: string[]) {
  leftOutOf.set(root, new Set(urls));
  root.querySelectorAll<HTMLIFrameElement>('iframe.me-island-frame').forEach(markLeftOut);
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
      const size = new Blob([node.attrs.html]).size;
      name.textContent = `${KIND_LABEL[node.attrs.kind] ?? 'HTML'}${node.attrs.label ? ` · ${node.attrs.label}` : ''} · ${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`}`;
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
      // HTML of your own (written in the HTML view, or pasted whole) is edited there: this opens it.
      if (node.attrs.kind === 'html') {
        const code = document.createElement('button');
        code.type = 'button';
        code.className = 'me-island-btn';
        code.textContent = 'Edit HTML';
        code.title = 'Edit it in the HTML view';
        code.onclick = () => dom.dispatchEvent(new CustomEvent('me-edit-html', { bubbles: true }));
        bar.append(code);
      }
      bar.append(remove);
      const sheet = document.createElement('div');
      sheet.className = 'me-island-sheet';
      const frame = document.createElement('iframe');
      frame.className = 'me-island-frame';
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = KIND_LABEL[node.attrs.kind] ?? 'HTML';
      // A quote starts folded, as in the reader; a forward open.
      let open = node.attrs.kind !== 'quote';
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
      dom.append(bar, sheet);
      const stop = fitFrame(frame);
      show();
      return {
        dom,
        stopEvent: (e) => !!(e.target as Element | null)?.closest?.('.me-island-btn'),
        ignoreMutation: () => true,
        destroy: stop,
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
    };
  },
  renderMarkdown: (node: { attrs?: { src?: string; alt?: string; ref?: string } }) => {
    const src = node.attrs?.src ?? '';
    const alt = (node.attrs?.alt ?? '').replace(/[[\]]/g, '');
    // Bytes stay out of the text: the view draws the picture from the id.
    return src.startsWith('data:') ? `![${alt}](dc-picture:${node.attrs?.ref ?? ''})` : `![${alt}](${src})`;
  },
  // Drawn as it is, but one from the web as a striped box: the editor fetches nothing from the web.
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement('img');
      const draw = (n: PMNode) => {
        const src = String(n.attrs.src ?? '');
        const web = fromWeb(src);
        img.src = web ? WEB_BOX : src;
        img.className = web ? 'me-pic-web' : '';
        img.alt = n.attrs.alt ?? '';
        if (web) img.title = webBoxTitle(src);
        else if (n.attrs.title) img.title = n.attrs.title;
        else img.removeAttribute('title');
        for (const k of ['width', 'height'] as const) {
          if (n.attrs[k] != null) img.setAttribute(k, String(n.attrs[k]));
          else img.removeAttribute(k);
        }
      };
      draw(node);
      return {
        dom: img,
        update: (n) => {
          if (n.type !== node.type) return false;
          draw(n);
          return true;
        },
      };
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
export function refsOf(editor: Editor): { islands: Map<string, IslandAttrs>; pictures: Map<string, string> } {
  const islands = new Map<string, IslandAttrs>();
  const pictures = new Map<string, string>();
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
    else if (String(n.attrs.src ?? '').startsWith('data:')) pictures.set(ref, n.attrs.src);
  });
  if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false));
  return { islands, pictures };
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
