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
import { type Editor, getHTMLFromFragment, type JSONContent, type MarkdownRendererHelpers, mergeAttributes, Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import { Markdown } from '@tiptap/markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';

/** A random id for an island or a picture, unique enough within one draft. */
export const newRef = () => Math.random().toString(36).slice(2, 10);

/** The frame an island is drawn in: a white sheet, its own styles, nothing that runs or fetches but pictures. */
export function islandDoc(html: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src https: http: data: blob:; style-src 'unsafe-inline'\">" +
    '<style>html,body{margin:0;background:#fff;color:#1f2328;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow:hidden}' +
    'body{padding:8px 10px}img{max-width:100%;height:auto}a{color:#0b62d6}blockquote[type=cite]{margin:0 0 0 2px;padding-left:10px;border-left:2px solid #c9d1d9;color:#57606a}</style></head>' +
    `<body>${html}</body></html>`
  );
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
    const natural = Math.max(wrap.scrollWidth, doc.documentElement.scrollWidth);
    let k = 1;
    if (W && natural > W + 1) {
      k = W / natural;
      wrap.style.width = `${natural}px`;
      wrap.style.transformOrigin = '0 0';
      wrap.style.transform = `scale(${k})`;
    }
    f.style.height = `${Math.max(24, Math.ceil(wrap.offsetHeight * k))}px`;
  };
  const loaded = () => {
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

export const Island = Node.create({
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
      bar.append(name, fold, remove);
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
export const Picture = Image.extend({
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
}).configure({ inline: true, allowBase64: true });

/** Colour (TextStyle) written into Markdown as a span, which comes back as colour. */
const ColorStyle = TextStyle.extend({
  renderMarkdown: (node: JSONContent, h: MarkdownRendererHelpers) => {
    const c = node.attrs?.color as string | undefined;
    const inner = h.renderChildren(node);
    return c ? `<span style="color:${c}">${inner}</span>` : inner;
  },
});

/** Every extension the document uses. */
export function extensions(placeholder: string) {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: null } },
      heading: { levels: [1, 2, 3] },
    }),
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

/** One fragment of the document as HTML (a cell, a paragraph), for writing what Markdown can't say. */
export function fragmentHtml(editor: Editor, node: PMNode): string {
  return getHTMLFromFragment(node.content, editor.schema);
}

/** Markdown of the document, with islands and pasted pictures as their stand-ins. */
export function docMarkdown(editor: Editor): string {
  refsOf(editor);
  return editor.getMarkdown();
}

/** Markdown (with stand-ins) back into the document: stand-ins become their islands and pictures again. */
export function markdownIn(editor: Editor, md: string, refs: { islands: Map<string, IslandAttrs>; pictures: Map<string, string> }) {
  const json = editor.markdown!.parse(md);
  const fix = (n: any): any => {
    if (n.type === 'paragraph' && n.content?.length === 1 && n.content[0].type === 'text') {
      const m = /^\[\[island:([\w-]+)\]\]$/.exec(String(n.content[0].text).trim());
      const isl = m && refs.islands.get(m[1]);
      if (isl) return { type: 'island', attrs: isl };
    }
    if (n.type === 'image') {
      const m = /^dc-picture:([\w-]+)$/.exec(n.attrs?.src ?? '');
      if (m) return { ...n, attrs: { ...n.attrs, src: refs.pictures.get(m[1]) ?? '', ref: m[1] } };
    }
    return n.content ? { ...n, content: n.content.map(fix) } : n;
  };
  editor.commands.setContent(fix(json), { emitUpdate: true });
}
